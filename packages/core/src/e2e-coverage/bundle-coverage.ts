import type { Profiler } from 'node:inspector';
import v8ToIstanbul from 'v8-to-istanbul';
import { parseJsonObject } from '../utils/json.js';
import { createCoverageReport, mergeIstanbulFile, parseIstanbulFileCoverage } from './collect.js';
import { mappedSourceLines, parseSourceMap, zeroUnmappedLines } from './source-map-lines.js';
import type { CoverageReport, IstanbulFileCoverage } from './types.js';

/** The e2e coverage of every renderer bundle entry folded in so far. */
export interface BundleCoverage {
  /** As v8-to-istanbul reports it: what `auditCoverageReport` grades. */
  readonly raw: CoverageReport;
  /** With every line the bundle has no code for set to 0: what gets published. */
  readonly zeroed: CoverageReport;
  /**
   * Per file, the lines some bundle has code for — the statement-line
   * restriction's fallback for a file whose statements it cannot compute.
   */
  readonly mappedLines: Map<string, Set<number>>;
}

export function createBundleCoverage(): BundleCoverage {
  return { raw: createCoverageReport(), zeroed: createCoverageReport(), mappedLines: new Map() };
}

/** One renderer bundle entry of a V8 dump, with the bundle's `.map` file read. */
export interface BundleEntry {
  readonly bundlePath: string;
  readonly code: string;
  readonly sourceMapText: string;
  readonly functions: readonly Profiler.FunctionCoverage[];
  /** Whether a source of the bundle belongs in the report. */
  readonly isProjectFile: (filePath: string) => boolean;
}

/**
 * Converts `entry` with v8-to-istanbul and folds its project files into
 * `coverage`. Returns an error, having folded in nothing, when the result
 * cannot be trusted — the caller must fail rather than publish without it:
 *
 * - The source map does not parse, or `mappedSourceLines` reports it as one
 *   v8-to-istanbul would mis-attribute.
 * - A file comes back in a shape `parseIstanbulFileCoverage` rejects. Skipping
 *   it would drop it from the report, and dropping predominantly uncovered
 *   files RAISES the number — neither the audit nor anything else could tell.
 * - A file comes back under a path the source map lookup does not have, so
 *   the mirror of v8-to-istanbul's path resolution has diverged from it:
 *   zeroing the file would hide its coverage and keeping it whole would credit
 *   its dead code.
 */
export async function addBundleEntry(
  coverage: BundleCoverage,
  entry: BundleEntry,
): Promise<{ readonly status: 'ok' } | { readonly status: 'error'; readonly message: string }> {
  const sourceMapPath = `${entry.bundlePath}.map`;
  const sourceMap = parseSourceMap(parseJsonObject(entry.sourceMapText));
  if (sourceMap === null) {
    return {
      status: 'error',
      message: `${sourceMapPath} is not a JSON source map with string mappings and sources.`,
    };
  }
  const mapped = mappedSourceLines(sourceMap, entry.bundlePath);
  if (mapped.status !== 'ok') {
    return {
      status: 'error',
      message:
        `${sourceMapPath} cannot be converted faithfully: ${mapped.reason}. ` +
        'The collector cannot tell covered from uncovered lines and refuses to guess.',
    };
  }

  // `originalSource` is read only for a one-source map without sourcesContent,
  // and an empty one falls through to reading the source from disk.
  const converter = v8ToIstanbul(entry.bundlePath, 0, {
    source: entry.code,
    originalSource: '',
    sourceMap: { sourcemap: sourceMap },
  });
  await converter.load();
  converter.applyCoverage(entry.functions);

  const files: { path: string; data: IstanbulFileCoverage; lines: ReadonlySet<number> }[] = [];
  for (const [filePath, value] of Object.entries(converter.toIstanbul())) {
    if (!entry.isProjectFile(filePath)) continue;
    const data = parseIstanbulFileCoverage(value);
    if (data === null) {
      return {
        status: 'error',
        message:
          `${filePath} came back from v8-to-istanbul in an unrecognised shape — ` +
          'the collector cannot tell covered from uncovered lines and refuses to guess. ' +
          'Check whether v8-to-istanbul changed its toIstanbul() output.',
      };
    }
    const lines = mapped.lines.get(filePath);
    if (lines === undefined) {
      return {
        status: 'error',
        message:
          `${filePath} is not a source of ${sourceMapPath} as mappedSourceLines resolves it — ` +
          "its mirror of v8-to-istanbul's source path resolution has diverged from it.",
      };
    }
    files.push({ path: filePath, data, lines });
  }

  for (const { path, data, lines } of files) {
    mergeIstanbulFile(coverage.raw, path, data);
    mergeIstanbulFile(coverage.zeroed, path, zeroUnmappedLines(data, lines));
    const known = coverage.mappedLines.get(path) ?? new Set<number>();
    for (const line of lines) known.add(line);
    coverage.mappedLines.set(path, known);
  }
  return { status: 'ok' };
}
