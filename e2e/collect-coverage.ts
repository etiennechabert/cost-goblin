/**
 * Turns the e2e suites' V8 coverage dumps into the lcov file SonarCloud reads.
 *
 * This file is I/O only. Everything that can be decided without touching the
 * filesystem — shard selection, the istanbul→lcov conversion and the
 * fail-closed report audit — lives in `packages/core/src/e2e-coverage/`, which
 * `npm run check` type-checks, lints and tests; `e2e/` is covered by none of
 * the three. Keep it that way: new logic belongs on the other side.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  addBundleEntry,
  auditCoverageReport,
  createBundleCoverage,
  describeCoverageFailure,
  generateLcov,
  isCoverageShardFile,
  isProjectSourcePath,
  isRendererBundleUrl,
  restrictToStatementLines,
} from '../packages/core/src/e2e-coverage/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const V8_DIR = join(tmpdir(), 'costgoblin-e2e-v8');
const OUTPUT_DIR = join(ROOT, 'coverage-e2e');

interface V8CoverageEntry {
  url: string;
  scriptId: string;
  source?: string;
  functions: {
    functionName: string;
    ranges: { startOffset: number; endOffset: number; count: number }[];
    isBlockCoverage: boolean;
  }[];
}

function fail(message: string): never {
  process.stderr.write(`::error::${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Glob all coverage-*.json shard files (and legacy coverage.json)
  let files: string[];
  try {
    files = readdirSync(V8_DIR).filter(isCoverageShardFile);
  } catch {
    files = [];
  }

  if (files.length === 0) {
    process.stdout.write('No V8 coverage found — skipping.\n');
    process.exit(0);
  }

  const entries: V8CoverageEntry[] = [];
  for (const file of files) {
    const raw = readFileSync(join(V8_DIR, file), 'utf-8');
    const parsed = JSON.parse(raw) as V8CoverageEntry[];
    entries.push(...parsed);
  }
  const relevant = entries.filter(e => isRendererBundleUrl(e.url));

  if (relevant.length === 0) {
    process.stderr.write('No relevant coverage entries found.\n');
    process.exit(0);
  }

  // Merged coverage per source file, across multiple test groups.
  const coverage = createBundleCoverage();
  const withoutSourceMap: string[] = [];

  const started = performance.now();
  for (const entry of relevant) {
    // fileURLToPath, not a prefix strip: the URL percent-encodes spaces and
    // non-ASCII characters in the checkout path.
    const urlPath = entry.url.startsWith('file:') ? fileURLToPath(entry.url) : entry.url;

    let sourceMapText: string;
    try {
      sourceMapText = readFileSync(`${urlPath}.map`, 'utf-8');
    } catch {
      // A whole bundle's worth of coverage, dropped. Expected locally, where
      // V8_DIR outlives a rebuild and still holds entries for bundle hashes
      // whose .map is gone — so this warns rather than fails. It must not do
      // it silently: this is the same "a dropped file raises the number"
      // shape that addBundleEntry refuses outright.
      withoutSourceMap.push(urlPath);
      continue;
    }

    const added = await addBundleEntry(coverage, {
      bundlePath: urlPath,
      code: entry.source ?? readFileSync(urlPath, 'utf-8'),
      sourceMapText,
      functions: entry.functions,
      isProjectFile: filePath => isProjectSourcePath(relative(ROOT, filePath)),
    });
    if (added.status === 'error') fail(added.message);
  }

  process.stdout.write(
    `Converted ${String(relevant.length)} renderer bundle entr${relevant.length === 1 ? 'y' : 'ies'} ` +
      `in ${((performance.now() - started) / 1000).toFixed(1)}s\n`,
  );

  if (withoutSourceMap.length > 0) {
    process.stderr.write(
      `::warning::Skipped ${String(withoutSourceMap.length)} of ${String(relevant.length)} ` +
        `coverage entries with no source map alongside them: ${withoutSourceMap.join(', ')}. ` +
        'Their coverage is missing from this report. If this is CI, the build and the V8 dump ' +
        'have gone out of sync.\n',
    );
  }

  // The audit reads v8-to-istanbul's report, every source line included: its
  // thresholds were measured on that shape, and it is the shape in which a
  // lost coverage-attach race shows up as inflation.
  const verdict = auditCoverageReport(coverage.raw);
  const outputPath = join(OUTPUT_DIR, 'lcov.info');

  // Both rejections happen BEFORE the report is written, and that ordering is
  // load-bearing. CI uploads `coverage-e2e/lcov.info` with `if: always()`, the
  // sonarcloud job's condition gates on lint and test-unit but not test-e2e,
  // and its merge loop accepts any shard file that is non-empty — so a report
  // written here reaches SonarCloud whatever exit code follows it. A rejected
  // report that still lands on disk is a rejected report that still moves the
  // number. The diagnostic copy below is named so the artifact glob misses it.
  if (verdict.status !== 'ok') {
    writeFileSync(`${outputPath}.rejected`, generateLcov(coverage.raw));
    fail(describeCoverageFailure(verdict));
  }

  const published = await restrictToStatementLines(coverage.measured, filePath => readFileSync(filePath, 'utf-8'));
  if (published.unrestricted.length > 0) {
    process.stderr.write(
      `::warning::Published ${String(published.unrestricted.length)} file(s) as the bundle has them, unaligned ` +
        `with the unit report, because their statement lines could not be computed: ${published.unrestricted.join(', ')}\n`,
    );
  }

  writeFileSync(outputPath, generateLcov(published.report));
  process.stdout.write(`E2E coverage written to ${outputPath}\n`);
  process.stdout.write(`  ${String(coverage.raw.size)} source files covered\n`);
}

void main();
