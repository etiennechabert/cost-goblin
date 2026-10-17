/**
 * Turns the e2e suites' V8 coverage dumps into the lcov files SonarCloud reads.
 *
 * Two sources feed it, converted, audited and written separately —
 * `coverage-e2e/lcov.info` and `coverage-e2e/lcov-main.info`:
 *  - the renderer: one `coverage-<shard>.json` per suite, harvested over CDP
 *    by helpers.ts's attachCoverage/finishCoverage;
 *  - the main process: `main/coverage-<pid>-<time>-<thread>.json`, written by
 *    Node itself because launchElectron sets NODE_V8_COVERAGE (two per launch:
 *    closeApp flushes one before quitting; see
 *    packages/core/src/e2e-coverage/main-process.ts).
 *
 * This file is I/O only. Everything that can be decided without touching the
 * filesystem — shard selection, the istanbul→lcov conversion and the
 * fail-closed report audit — lives in `packages/core/src/e2e-coverage/`, which
 * `npm run check` type-checks, lints and tests; `e2e/` is covered by none of
 * the three. Keep it that way: new logic belongs on the other side.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  addBundleEntry,
  auditCoverageReport,
  createBundleCoverage,
  describeCoverageFailure,
  describeMainCoverageFailure,
  dumpEntryFreshness,
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
// The two reports this script writes into OUTPUT_DIR; ci.yml's upload and
// merge steps name both.
const RENDERER_REPORT = 'lcov.info';
const MAIN_REPORT = 'lcov-main.info';

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

/** A main bundle read once per collector run: every dump entry of one launch
 *  set references the same few files. */
type BundleRead =
  | { readonly status: 'ok'; readonly code: string; readonly sourceMapText: string }
  | { readonly status: 'no-source-map' };

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
  const bundles = new Map<string, BundleRead>();
  const truncated: string[] = [];
  const stale: string[] = [];
  const missingBundle = new Set<string>();
  const withoutSourceMap = new Set<string>();
  let converted = 0;

  const started = performance.now();
  for (const file of files) {
    const dumpPath = join(MAIN_V8_DIR, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(dumpPath, 'utf-8'));
    } catch {
      // Node writes the dump straight to its final name, so a process killed
      // mid-write leaves a truncated file. Skipping it can only lower the
      // number (the flushed dump of the same launch still counts), so this
      // warns. A dump that parses but has the wrong shape still fails below.
      truncated.push(file);
      continue;
    }
    const scripts = parseNodeCoverageDump(parsed);
    if (scripts === null) {
      fail(`${dumpPath} is not a NODE_V8_COVERAGE dump the collector understands — refusing to guess at its coverage.`);
    }
    const writtenAt = statSync(dumpPath).mtimeMs;

    for (const script of scripts) {
      if (!isMainBundleUrl(script.url)) continue;
      const bundlePath = fileURLToPath(script.url);
      let builtAt: number | null;
      try {
        builtAt = statSync(bundlePath).mtimeMs;
      } catch {
        builtAt = null;
      }
      const freshness = dumpEntryFreshness(writtenAt, builtAt);
      if (freshness === 'bundle-missing') {
        missingBundle.add(relative(ROOT, bundlePath));
        continue;
      }
      if (freshness === 'stale') {
        stale.push(`${file} (${relative(ROOT, bundlePath)})`);
        continue;
      }

      let bundle = bundles.get(bundlePath);
      if (bundle === undefined) {
        try {
          bundle = {
            status: 'ok',
            code: readFileSync(bundlePath, 'utf-8'),
            sourceMapText: readFileSync(`${bundlePath}.map`, 'utf-8'),
          };
        } catch {
          bundle = { status: 'no-source-map' };
        }
        bundles.set(bundlePath, bundle);
      }
      if (bundle.status === 'no-source-map') {
        withoutSourceMap.add(relative(ROOT, bundlePath));
        continue;
      }

      const added = await addBundleEntry(coverage, {
        bundlePath,
        code: bundle.code,
        sourceMapText: bundle.sourceMapText,
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
  if (truncated.length > 0) {
    process.stderr.write(
      `::warning::Skipped ${String(truncated.length)} main-process coverage dump(s) that are not valid JSON — ` +
        `most likely cut short by a killed process: ${truncated.join(', ')}.\n`,
    );
  }
  if (stale.length > 0) {
    process.stderr.write(
      `::warning::Skipped ${String(stale.length)} main-process coverage entr${stale.length === 1 ? 'y' : 'ies'} ` +
        `taken before the bundle was last rebuilt: ${stale.join(', ')}. Re-run the e2e suites to measure the ` +
        'current build.\n',
    );
  }
  if (missingBundle.size > 0) {
    process.stderr.write(
      `::warning::Skipped main-process coverage of ${[...missingBundle].join(', ')}: the bundle is no longer on disk. ` +
        'Rebuild with `npm run build --workspace=packages/desktop` and re-run the e2e suites.\n',
    );
  }
  if (withoutSourceMap.size > 0) {
    process.stderr.write(
      `::warning::Skipped main-process coverage of ${[...withoutSourceMap].join(', ')}: no source map alongside it. ` +
        'Build with `npm run build --workspace=packages/desktop` (it passes --sourcemap).\n',
    );
  }
  return coverage;
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  // OUTPUT_DIR is a stable path: clear what an earlier run wrote, or a report
  // would outlive a run that produced none.
  for (const name of [RENDERER_REPORT, MAIN_REPORT]) {
    rmSync(join(OUTPUT_DIR, name), { force: true });
    rmSync(join(OUTPUT_DIR, `${name}.rejected`), { force: true });
  }

  const renderer = await rendererCoverage();
  const mainProcess = await mainProcessCoverage();
  if (renderer === null && mainProcess === null) {
    process.stdout.write('No V8 coverage found — skipping.\n');
    process.exit(0);
  }

  // One report file per source. CI's merge step requires the renderer report
  // from the shards that harvest it and the main report from every shard, so
  // a source that silently stops producing coverage fails there instead of
  // hiding behind the other one. Separate files also mean separate lcov
  // records: a file bundled into both (core code the renderer and the main
  // process share) carries branch ids from two different bundle ASTs, which
  // one record would count twice.
  const sources = [
    ...(renderer === null ? [] : [{ coverage: renderer, file: RENDERER_REPORT, describe: describeCoverageFailure }]),
    ...(mainProcess === null ? [] : [{ coverage: mainProcess, file: MAIN_REPORT, describe: describeMainCoverageFailure }]),
  ];

  // Each source is audited on its own. The audit reads v8-to-istanbul's
  // report, every source line included: its thresholds were measured on the
  // renderer's shape, and it is the shape in which a lost coverage-attach
  // race shows up as inflation. Pooling the main process's files in would
  // dilute exactly the share it measures.
  //
  // Both rejections happen BEFORE any report is written, and that ordering is
  // load-bearing. CI uploads `coverage-e2e/` with `if: always()`, the
  // sonarcloud job's condition gates on lint and test-unit but not test-e2e,
  // and its merge loop accepts any shard file that is non-empty — so a report
  // written here reaches SonarCloud whatever exit code follows it. A rejected
  // report that still lands on disk is a rejected report that still moves the
  // number. The diagnostic copy below is named so the merge never reads it.
  for (const { coverage, file, describe } of sources) {
    const verdict = auditCoverageReport(coverage.raw);
    if (verdict.status !== 'ok') {
      writeFileSync(join(OUTPUT_DIR, `${file}.rejected`), generateLcov(coverage.raw));
      fail(describe(verdict));
    }
  }

  for (const { coverage, file } of sources) {
    const restricted = await restrictToStatementLines(coverage.measured, filePath => readFileSync(filePath, 'utf-8'));
    if (restricted.unrestricted.length > 0) {
      process.stderr.write(
        `::warning::Published ${String(restricted.unrestricted.length)} file(s) as the bundle has them, unaligned ` +
          `with the unit report, because their statement lines could not be computed: ${restricted.unrestricted.join(', ')}\n`,
      );
    }
    const outputPath = join(OUTPUT_DIR, file);
    writeFileSync(outputPath, generateLcov(restricted.report));
    process.stdout.write(`E2E coverage written to ${outputPath} (${String(coverage.raw.size)} source files)\n`);
  }
}

void main();
