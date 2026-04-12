import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

  let raw: string;
  try {
    raw = readFileSync(join(V8_DIR, 'coverage.json'), 'utf-8');
  } catch {
    process.stderr.write('No V8 coverage found. Run E2E tests first.\n');
    process.exit(1);
  }

  const entries = JSON.parse(raw) as V8CoverageEntry[];
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

  const lcov = lcovParts.join('\n');
  const outputPath = join(OUTPUT_DIR, 'lcov.info');
  writeFileSync(outputPath, lcov);
  process.stdout.write(`E2E coverage written to ${outputPath}\n`);
  process.stdout.write(`  ${String(merged.size)} source files covered\n`);
}

void main();
