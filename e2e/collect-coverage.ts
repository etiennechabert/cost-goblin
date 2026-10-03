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
import v8ToIstanbul from 'v8-to-istanbul';
import {
  auditCoverageReport,
  createCoverageReport,
  describeCoverageFailure,
  executableLines,
  generateLcov,
  isCoverageShardFile,
  isProjectSourcePath,
  isRendererBundleUrl,
  mergeIstanbulFile,
  parseIstanbulFileCoverage,
  restrictToExecutableLines,
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

  // Merged coverage per source file (across multiple test groups)
  const merged = createCoverageReport();
  const withoutSourceMap: string[] = [];

  for (const entry of relevant) {
    const urlPath = entry.url.replace(/^file:\/\//, '');
    const sourceMapPath = `${urlPath}.map`;

    let sourceMap: string;
    try {
      sourceMap = readFileSync(sourceMapPath, 'utf-8');
    } catch {
      // A whole bundle's worth of coverage, dropped. Expected locally, where
      // V8_DIR outlives a rebuild and still holds entries for bundle hashes
      // whose .map is gone — so this warns rather than fails. It must not do
      // it silently: this is the same "a dropped file raises the number"
      // shape that the parse failure below refuses outright.
      withoutSourceMap.push(urlPath);
      continue;
    }

    const converter = v8ToIstanbul(urlPath, 0, {
      source: entry.source ?? readFileSync(urlPath, 'utf-8'),
      sourceMap: { sourcemap: JSON.parse(sourceMap) as object },
    });

    await converter.load();
    converter.applyCoverage(entry.functions);

    for (const [filePath, data] of Object.entries(converter.toIstanbul())) {
      if (!isProjectSourcePath(relative(ROOT, filePath))) continue;
      const fileData = parseIstanbulFileCoverage(data);
      // Not skippable: an entry we cannot read is a file dropped from the
      // report, and dropping predominantly-uncovered files RAISES the number.
      // The audit cannot see that — the report is neither empty nor fabricated
      // — so this has to fail here. The pre-extraction collector crashed on
      // the same input; this is the same outcome with a usable message.
      if (fileData === null) {
        fail(
          `${filePath} came back from v8-to-istanbul in an unrecognised shape — ` +
            'the collector cannot tell covered from uncovered lines and refuses to guess. ' +
            'Check whether v8-to-istanbul changed its toIstanbul() output.',
        );
      }
      mergeIstanbulFile(merged, filePath, fileData);
    }
  }

  if (withoutSourceMap.length > 0) {
    process.stderr.write(
      `::warning::Skipped ${String(withoutSourceMap.length)} of ${String(relevant.length)} ` +
        `coverage entries with no source map alongside them: ${withoutSourceMap.join(', ')}. ` +
        'Their coverage is missing from this report. If this is CI, the build and the V8 dump ' +
        'have gone out of sync.\n',
    );
  }

  // The audit reads the report exactly as v8-to-istanbul produced it, every
  // source line included: its thresholds were measured on that shape, and the
  // statement-line restriction below would shrink the files it looks at.
  const verdict = auditCoverageReport(merged);
  const outputPath = join(OUTPUT_DIR, 'lcov.info');

  // Both rejections happen BEFORE the report is written, and that ordering is
  // load-bearing. CI uploads `coverage-e2e/lcov.info` with `if: always()`, the
  // sonarcloud job's condition gates on lint and test-unit but not test-e2e,
  // and its merge loop accepts any shard file that is non-empty — so a report
  // written here reaches SonarCloud whatever exit code follows it. A rejected
  // report that still lands on disk is a rejected report that still moves the
  // number. The diagnostic copy below is named so the artifact glob misses it.
  if (verdict.status !== 'ok') {
    writeFileSync(`${outputPath}.rejected`, generateLcov(merged));
    fail(describeCoverageFailure(verdict));
  }

  const executable = new Map<string, ReadonlySet<number>>();
  const unrestricted: string[] = [];
  for (const filePath of merged.keys()) {
    try {
      const lines = await executableLines(readFileSync(filePath, 'utf-8'), filePath);
      if (lines === null) unrestricted.push(`${filePath} (unsupported file type)`);
      else executable.set(filePath, lines);
    } catch (error) {
      unrestricted.push(`${filePath} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  // A file that falls back keeps every source line, exactly as the report did
  // before this restriction existed. That undercounts it wherever the unit
  // report is the one covering it; it does not credit any new line, so this
  // warns rather than fails.
  if (unrestricted.length > 0) {
    process.stderr.write(
      `::warning::Could not compute statement lines for ${String(unrestricted.length)} file(s); ` +
        `their every source line stays in the report: ${unrestricted.join(', ')}\n`,
    );
  }

  writeFileSync(outputPath, generateLcov(restrictToExecutableLines(merged, executable)));
  process.stdout.write(`E2E coverage written to ${outputPath}\n`);
  process.stdout.write(`  ${String(merged.size)} source files covered\n`);
}

void main();
