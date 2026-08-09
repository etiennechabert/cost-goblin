import type {
  CoverageFailure,
  CoverageReport,
  CoverageVerdict,
  FileCoverage,
  ZeroFunctionStats,
} from './types.js';

/**
 * Thresholds for the fabricated-report guard.
 *
 * v8-to-istanbul is subtractive: every line starts at count 1 ("covered") and
 * is only zeroed by a count-0 range (v8-to-istanbul/lib/line.js). So a file V8
 * reported NO functions for is emitted as 100% covered rather than uncovered.
 * When a shard loses the coverage-attach race badly, most of the bundle lands
 * in that state and the shard reports ~90% — and because Sonar unions the
 * shard reports, one such shard lifted the whole project number. That is the
 * saw-tooth: main alternated between ~66% and ~82%.
 *
 * Measured over all 12 shard artifacts of the two runs that bracketed the last
 * swing (CI runs 31297825638 and 31298668331):
 *   10 honest shards : 10-11 zero-function files,  10.7-13.8% of hits
 *   2 inflated shards: 69-70 zero-function files,  49.8-52.4% of hits
 * Both conditions must blow out together to fail, and each threshold sits
 * ~2.5x above anything a healthy shard has produced. The small honest baseline
 * is real: type-only and constant modules (packages/core/src/types/*,
 * ui/components/ui/button.tsx) genuinely contain no functions.
 */
const ZERO_FUNCTION_FILE_LIMIT = 25;
const ZERO_FUNCTION_HIT_SHARE_LIMIT = 0.3;

/**
 * The largest file the guard ignores — a zero-function file of up to this many
 * lines does not count, one line longer does. A handful of covered lines with
 * no functions is an ordinary constant or barrel module, and counting them
 * would put the honest baseline within reach of the file threshold.
 *
 * Named for the largest *ignored* size rather than the smallest suspicious one
 * because that is what the `>` below compares against: retuning this to "the
 * file size I want to start catching" would move the boundary a line the wrong
 * way.
 */
const LARGEST_IGNORED_FILE_LINES = 20;

function hits(coverage: FileCoverage): number {
  return [...coverage.lines.values()].filter(count => count > 0).length;
}

/** Measures how much of `report` rests on files with no function records. */
export function measureZeroFunctionFiles(report: CoverageReport): ZeroFunctionStats {
  const all = [...report.values()];
  const suspects = all.filter(
    coverage => coverage.functions.size === 0 && coverage.lines.size > LARGEST_IGNORED_FILE_LINES,
  );
  const suspectHits = suspects.reduce((sum, coverage) => sum + hits(coverage), 0);
  const totalHits = all.reduce((sum, coverage) => sum + hits(coverage), 0);
  return {
    files: suspects.length,
    hitShare: totalHits === 0 ? 0 : suspectHits / totalHits,
  };
}

/**
 * Decides whether a merged report is a measurement worth publishing.
 *
 * Fails closed on the two ways the pipeline has silently produced a green
 * number: no records at all, and a report dominated by files V8 never reported
 * functions for.
 */
export function auditCoverageReport(report: CoverageReport): CoverageVerdict {
  if (report.size === 0) return { status: 'empty' };

  const zeroFunction = measureZeroFunctionFiles(report);
  if (
    zeroFunction.files > ZERO_FUNCTION_FILE_LIMIT &&
    zeroFunction.hitShare > ZERO_FUNCTION_HIT_SHARE_LIMIT
  ) {
    return { status: 'fabricated', sourceFiles: report.size, zeroFunction };
  }

  return { status: 'ok', sourceFiles: report.size, zeroFunction };
}

/** The diagnostic CI prints for a rejected report. */
export function describeCoverageFailure(failure: CoverageFailure): string {
  switch (failure.status) {
    case 'empty':
      return 'E2E coverage produced no source records — the coverage pipeline is broken.';
    case 'fabricated':
      return (
        `${String(failure.zeroFunction.files)} files reported no functions at all and were credited ` +
        `${(failure.zeroFunction.hitShare * 100).toFixed(1)}% of this shard's covered lines — the report is fabricated, ` +
        'not measured. The suite almost certainly attached coverage too late: call startCoverage(page) ' +
        'immediately after app.firstWindow(), before any other await.'
      );
  }
}
