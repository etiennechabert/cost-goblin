import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import v8ToIstanbul from 'v8-to-istanbul';

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

interface FileCoverage {
  lines: Map<number, number>;
  functions: Map<string, { line: number; count: number }>;
  branches: { line: number; blockId: number; branchId: number; count: number }[];
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Glob all coverage-*.json shard files (and legacy coverage.json)
  let files: string[];
  try {
    files = readdirSync(V8_DIR).filter(f => f.match(/^coverage(-[\w-]+)?\.json$/));
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
  const relevant = entries.filter(e =>
    e.url.includes('/assets/index-') && e.url.endsWith('.js'),
  );

  if (relevant.length === 0) {
    process.stderr.write('No relevant coverage entries found.\n');
    process.exit(0);
  }

  // Merged coverage per source file (across multiple test groups)
  const merged = new Map<string, FileCoverage>();

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

    const istanbul = converter.toIstanbul();

    for (const [filePath, data] of Object.entries(istanbul)) {
      const rel = relative(ROOT, filePath);
      if (!rel.startsWith('packages/')) continue;
      if (rel.includes('node_modules')) continue;

      const fileData = data as {
        statementMap: Record<string, { start: { line: number; column: number }; end: { line: number; column: number } }>;
        s: Record<string, number>;
        fnMap: Record<string, { name: string; loc: { start: { line: number; column: number } } }>;
        f: Record<string, number>;
        branchMap: Record<string, { type: string; locations: { start: { line: number; column: number } }[] }>;
        b: Record<string, number[]>;
      };

      let existing = merged.get(filePath);
      if (existing === undefined) {
        existing = { lines: new Map(), functions: new Map(), branches: [] };
        merged.set(filePath, existing);
      }

      // Merge line coverage (take max)
      for (const [id, stmt] of Object.entries(fileData.statementMap)) {
        const count = fileData.s[id] ?? 0;
        const line = stmt.start.line;
        const prev = existing.lines.get(line) ?? 0;
        existing.lines.set(line, Math.max(prev, count));
      }

      // Merge function coverage (take max per function name+line)
      for (const [id, fn] of Object.entries(fileData.fnMap)) {
        const count = fileData.f[id] ?? 0;
        const key = `${fn.name || `anon_${id}`}:${String(fn.loc.start.line)}`;
        const prev = existing.functions.get(key);
        if (prev === undefined || count > prev.count) {
          existing.functions.set(key, { line: fn.loc.start.line, count });
        }
      }

      // Merge branches (take max per location)
      let blockId = 0;
      for (const [id, branch] of Object.entries(fileData.branchMap)) {
        const counts = fileData.b[id] ?? [];
        for (let i = 0; i < branch.locations.length; i++) {
          const loc = branch.locations[i];
          if (loc === undefined) continue;
          const count = counts[i] ?? 0;
          existing.branches.push({ line: loc.start.line, blockId, branchId: i, count });
        }
        blockId++;
      }
    }
  }

  // Generate lcov
  const lcovParts: string[] = [];

  for (const [filePath, cov] of merged) {
    const lines: string[] = [];
    lines.push('TN:');
    lines.push(`SF:${filePath}`);

    // Functions
    for (const [key, fn] of cov.functions) {
      const name = key.split(':')[0] ?? key;
      lines.push(`FN:${String(fn.line)},${name}`);
    }
    lines.push(`FNF:${String(cov.functions.size)}`);
    const fnHit = [...cov.functions.values()].filter(f => f.count > 0).length;
    lines.push(`FNH:${String(fnHit)}`);
    for (const [key, fn] of cov.functions) {
      const name = key.split(':')[0] ?? key;
      lines.push(`FNDA:${String(fn.count)},${name}`);
    }

    // Lines
    let linesHit = 0;
    for (const [line, count] of [...cov.lines.entries()].sort((a, b) => a[0] - b[0])) {
      lines.push(`DA:${String(line)},${String(count)}`);
      if (count > 0) linesHit++;
    }
    lines.push(`LF:${String(cov.lines.size)}`);
    lines.push(`LH:${String(linesHit)}`);

    // Branches (deduplicate by taking max count per line+block+branch)
    const branchMap = new Map<string, number>();
    for (const b of cov.branches) {
      const key = `${String(b.line)}:${String(b.blockId)}:${String(b.branchId)}`;
      branchMap.set(key, Math.max(branchMap.get(key) ?? 0, b.count));
    }
    let branchesHit = 0;
    for (const [key, count] of branchMap) {
      const [line, block, branch] = key.split(':');
      lines.push(`BRDA:${line ?? '0'},${block ?? '0'},${branch ?? '0'},${count > 0 ? String(count) : '-'}`);
      if (count > 0) branchesHit++;
    }
    lines.push(`BRF:${String(branchMap.size)}`);
    lines.push(`BRH:${String(branchesHit)}`);

    lines.push('end_of_record');
    lcovParts.push(lines.join('\n'));
  }

  // A report with no records would still be a non-empty file (the trailing
  // newline below), which is exactly what CI's `[ -s "$f" ]` merge guard
  // accepts — a silent total outage reported as green. Fail instead.
  if (merged.size === 0) {
    process.stderr.write(
      '::error::E2E coverage produced no source records — the coverage pipeline is broken.\n',
    );
    process.exit(1);
  }

  // Trailing newline is load-bearing: CI concatenates the per-shard files,
  // and without it the boundary fuses `end_of_record` with the next shard's
  // first line into a corrupt record.
  const lcov = `${lcovParts.join('\n')}\n`;
  const outputPath = join(OUTPUT_DIR, 'lcov.info');
  writeFileSync(outputPath, lcov);
  process.stdout.write(`E2E coverage written to ${outputPath}\n`);
  process.stdout.write(`  ${String(merged.size)} source files covered\n`);

  // Fail closed on a fabricated report.
  //
  // v8-to-istanbul is subtractive: every line starts at count 1 ("covered")
  // and is only zeroed by a count-0 range (v8-to-istanbul/lib/line.js). So a
  // file V8 reported NO functions for is emitted as 100% covered rather than
  // uncovered. When a shard loses the coverage-attach race badly, most of the
  // bundle lands in that state and the shard reports ~90% — and because Sonar
  // unions the shard reports, one such shard lifted the whole project number.
  // That is the saw-tooth: main alternated between ~66% and ~82%.
  //
  // Measured over all 12 shard artifacts of the two runs that bracketed the
  // last swing (CI runs 31297825638 and 31298668331):
  //   10 honest shards : 10-11 zero-function files,  10.7-13.8% of hits
  //   2 inflated shards: 69-70 zero-function files,  49.8-52.4% of hits
  // Both conditions must blow out together to fail, and each threshold sits
  // ~2.5x above anything a healthy shard has produced. The small honest
  // baseline is real: type-only and constant modules (packages/core/src/types/*,
  // ui/components/ui/button.tsx) genuinely contain no functions.
  const fabricated = [...merged.values()].filter(
    cov => cov.functions.size === 0 && cov.lines.size > 20,
  );
  const hits = (cov: FileCoverage): number =>
    [...cov.lines.values()].filter(count => count > 0).length;
  const fabricatedHits = fabricated.reduce((sum, cov) => sum + hits(cov), 0);
  const totalHits = [...merged.values()].reduce((sum, cov) => sum + hits(cov), 0);
  const fabricatedShare = totalHits === 0 ? 0 : fabricatedHits / totalHits;

  if (fabricated.length > 25 && fabricatedShare > 0.3) {
    process.stderr.write(
      `::error::${String(fabricated.length)} files reported no functions at all and were credited ` +
        `${(fabricatedShare * 100).toFixed(1)}% of this shard's covered lines — the report is fabricated, ` +
        'not measured. The suite almost certainly attached coverage too late: call startCoverage(page) ' +
        'immediately after app.firstWindow(), before any other await.\n',
    );
    process.exit(1);
  }
}

void main();
