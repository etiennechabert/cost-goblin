/**
 * Turns the e2e suites' V8 coverage dumps into the lcov file SonarCloud reads.
 *
 * Two sources feed it, converted separately and published as separate lcov
 * records:
 *  - the renderer: one `coverage-<shard>.json` per suite, harvested over CDP
 *    by helpers.ts's attachCoverage/finishCoverage;
 *  - the main process: one `main/coverage-<pid>-<time>-<thread>.json` per
 *    launch, written by Node itself because launchElectron sets
 *    NODE_V8_COVERAGE (see packages/core/src/e2e-coverage/main-process.ts).
 *
 * This file is I/O only. Everything that can be decided without touching the
 * filesystem — shard selection, the istanbul→lcov conversion and the
 * fail-closed report audit — lives in `packages/core/src/e2e-coverage/`, which
 * `npm run check` type-checks, lints and tests; `e2e/` is covered by none of
 * the three. Keep it that way: new logic belongs on the other side.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  addBundleEntry,
  auditCoverageReport,
  createBundleCoverage,
  describeCoverageFailure,
  describeMainCoverageFailure,
  generateLcov,
  isCoverageShardFile,
  isMainBundleUrl,
  isNodeCoverageDumpFile,
  isProjectSourcePath,
  isRendererBundleUrl,
  parseNodeCoverageDump,
  restrictToStatementLines,
} from '../packages/core/src/e2e-coverage/index.js';
import type { BundleCoverage } from '../packages/core/src/e2e-coverage/index.js';

const ROOT = resolve(import.meta.dirname, '..');
// Both must match e2e/helpers.ts (V8_DIR, MAIN_V8_DIR). Not imported from
// there: helpers.ts pulls in @playwright/test, which this script has no use for.
const V8_DIR = join(tmpdir(), 'costgoblin-e2e-v8');
const MAIN_V8_DIR = join(V8_DIR, 'main');
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

function isProjectFile(filePath: string): boolean {
  return isProjectSourcePath(relative(ROOT, filePath));
}

/** The renderer shards' coverage, or `null` when no suite harvested any. */
async function rendererCoverage(): Promise<BundleCoverage | null> {
  // Glob all coverage-*.json shard files (and legacy coverage.json)
  let files: string[];
  try {
    files = readdirSync(V8_DIR).filter(isCoverageShardFile);
  } catch {
    files = [];
  }
  if (files.length === 0) return null;

  const entries: V8CoverageEntry[] = [];
  for (const file of files) {
    const raw = readFileSync(join(V8_DIR, file), 'utf-8');
    const parsed = JSON.parse(raw) as V8CoverageEntry[];
    entries.push(...parsed);
  }
  const relevant = entries.filter(e => isRendererBundleUrl(e.url));

  if (relevant.length === 0) {
    process.stderr.write('No relevant renderer coverage entries found.\n');
    return null;
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
      isProjectFile,
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
  return coverage;
}

/** The main-process dumps' coverage, or `null` when no launch wrote one. */
async function mainProcessCoverage(): Promise<BundleCoverage | null> {
  let files: string[];
  try {
    files = readdirSync(MAIN_V8_DIR).filter(isNodeCoverageDumpFile);
  } catch {
    files = [];
  }
  if (files.length === 0) return null;

  const coverage = createBundleCoverage();
  const stale: string[] = [];
  const withoutSourceMap: string[] = [];
  let converted = 0;

  const started = performance.now();
  for (const file of files) {
    const dumpPath = join(MAIN_V8_DIR, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(dumpPath, 'utf-8'));
    } catch {
      parsed = null;
    }
    const scripts = parseNodeCoverageDump(parsed);
    if (scripts === null) {
      fail(`${dumpPath} is not a NODE_V8_COVERAGE dump the collector understands — refusing to guess at its coverage.`);
    }
    const writtenAt = statSync(dumpPath).mtimeMs;

    for (const script of scripts) {
      if (!isMainBundleUrl(script.url)) continue;
      const bundlePath = fileURLToPath(script.url);
      // The bundle's path never changes between builds (out/main/main.js),
      // so a dump taken before the latest rebuild would map its offsets onto
      // the wrong code without any error. Only possible locally: CI builds
      // once, then runs, and globalSetup empties V8_DIR at the start of every
      // run.
      let builtAt: number;
      try {
        builtAt = statSync(bundlePath).mtimeMs;
      } catch {
        builtAt = Number.POSITIVE_INFINITY;
      }
      if (builtAt > writtenAt) {
        stale.push(`${file} (${relative(ROOT, bundlePath)})`);
        continue;
      }

      let sourceMapText: string;
      try {
        sourceMapText = readFileSync(`${bundlePath}.map`, 'utf-8');
      } catch {
        withoutSourceMap.push(bundlePath);
        continue;
      }

      const added = await addBundleEntry(coverage, {
        bundlePath,
        code: readFileSync(bundlePath, 'utf-8'),
        sourceMapText,
        functions: script.functions,
        isProjectFile,
      });
      if (added.status === 'error') fail(added.message);
      converted++;
    }
  }

  process.stdout.write(
    `Converted ${String(converted)} main-process bundle entr${converted === 1 ? 'y' : 'ies'} from ` +
      `${String(files.length)} dump${files.length === 1 ? '' : 's'} in ` +
      `${((performance.now() - started) / 1000).toFixed(1)}s\n`,
  );
  if (stale.length > 0) {
    process.stderr.write(
      `::warning::Skipped ${String(stale.length)} main-process coverage entr${stale.length === 1 ? 'y' : 'ies'} ` +
        `taken before the bundle was last rebuilt: ${stale.join(', ')}. Re-run the e2e suites to measure the ` +
        'current build.\n',
    );
  }
  if (withoutSourceMap.length > 0) {
    process.stderr.write(
      `::warning::Skipped main-process coverage of ${withoutSourceMap.join(', ')}: no source map alongside it. ` +
        'Build with `npm run build --workspace=packages/desktop` (it passes --sourcemap).\n',
    );
  }
  return coverage;
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const renderer = await rendererCoverage();
  const mainProcess = await mainProcessCoverage();
  if (renderer === null && mainProcess === null) {
    process.stdout.write('No V8 coverage found — skipping.\n');
    process.exit(0);
  }

  const outputPath = join(OUTPUT_DIR, 'lcov.info');
  const sources = [
    ...(renderer === null ? [] : [{ coverage: renderer, describe: describeCoverageFailure }]),
    ...(mainProcess === null ? [] : [{ coverage: mainProcess, describe: describeMainCoverageFailure }]),
  ];

  // Each source is audited on its own. The audit reads v8-to-istanbul's
  // report, every source line included: its thresholds were measured on the
  // renderer's shape, and it is the shape in which a lost coverage-attach
  // race shows up as inflation. Pooling the main process's files in would
  // dilute exactly the share it measures.
  //
  // Both rejections happen BEFORE the report is written, and that ordering is
  // load-bearing. CI uploads `coverage-e2e/lcov.info` with `if: always()`, the
  // sonarcloud job's condition gates on lint and test-unit but not test-e2e,
  // and its merge loop accepts any shard file that is non-empty — so a report
  // written here reaches SonarCloud whatever exit code follows it. A rejected
  // report that still lands on disk is a rejected report that still moves the
  // number. The diagnostic copy below is named so the artifact glob misses it.
  for (const { coverage, describe } of sources) {
    const verdict = auditCoverageReport(coverage.raw);
    if (verdict.status !== 'ok') {
      writeFileSync(`${outputPath}.rejected`, generateLcov(coverage.raw));
      fail(describe(verdict));
    }
  }

  // One lcov text per source, concatenated rather than merged into one record
  // per file: a file bundled into both (core code the renderer and the main
  // process share) carries branch ids from two different bundle ASTs, which
  // one record would count twice. SonarJS merges same-file records the way it
  // merges the CI shards (lines summed, branches matched per record).
  let published = '';
  for (const { coverage } of sources) {
    const restricted = await restrictToStatementLines(coverage.measured, filePath => readFileSync(filePath, 'utf-8'));
    if (restricted.unrestricted.length > 0) {
      process.stderr.write(
        `::warning::Published ${String(restricted.unrestricted.length)} file(s) as the bundle has them, unaligned ` +
          `with the unit report, because their statement lines could not be computed: ${restricted.unrestricted.join(', ')}\n`,
      );
    }
    published += generateLcov(restricted.report);
  }

  writeFileSync(outputPath, published);
  process.stdout.write(`E2E coverage written to ${outputPath}\n`);
  if (renderer !== null) process.stdout.write(`  renderer: ${String(renderer.raw.size)} source files covered\n`);
  if (mainProcess !== null) process.stdout.write(`  main process: ${String(mainProcess.raw.size)} source files covered\n`);
}

void main();
