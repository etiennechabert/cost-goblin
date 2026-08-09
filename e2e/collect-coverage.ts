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
  generateLcov,
  isCoverageShardFile,
  isProjectSourcePath,
  isRendererBundleUrl,
  mergeIstanbulFile,
  parseIstanbulFileCoverage,
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

  for (const entry of relevant) {
    const urlPath = entry.url.replace(/^file:\/\//, '');
    const sourceMapPath = `${urlPath}.map`;

    let sourceMap: string;
    try {
      sourceMap = readFileSync(sourceMapPath, 'utf-8');
    } catch {
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
      if (fileData === null) continue;
      mergeIstanbulFile(merged, filePath, fileData);
    }
  }

  const verdict = auditCoverageReport(merged);

  // Rejected before writing: an empty report still renders as a one-byte file
  // (lcov's trailing newline), which is exactly what CI's `[ -s "$f" ]` merge
  // guard accepts — a silent total outage reported as green.
  if (verdict.status === 'empty') fail(describeCoverageFailure(verdict));

  const outputPath = join(OUTPUT_DIR, 'lcov.info');
  writeFileSync(outputPath, generateLcov(merged));
  process.stdout.write(`E2E coverage written to ${outputPath}\n`);
  process.stdout.write(`  ${String(merged.size)} source files covered\n`);

  // Written before being rejected, so the shard is still available as a CI
  // artifact to diagnose the fabrication against.
  if (verdict.status === 'fabricated') fail(describeCoverageFailure(verdict));
}

void main();
