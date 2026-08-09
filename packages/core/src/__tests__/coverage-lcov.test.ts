import { describe, it, expect } from 'vitest';
import {
  createCoverageReport,
  isCoverageShardFile,
  isProjectSourcePath,
  isRendererBundleUrl,
  mergeIstanbulFile,
  parseIstanbulFileCoverage,
} from '../e2e-coverage/collect.js';
import { generateLcov } from '../e2e-coverage/lcov.js';
import { auditCoverageReport } from '../e2e-coverage/audit.js';
import type { IstanbulFileCoverage } from '../e2e-coverage/types.js';

/** An istanbul location node, in the shape v8-to-istanbul emits. */
function loc(line: number): unknown {
  return { start: { line, column: 0 }, end: { line, column: 40 } };
}

/**
 * One entry of `v8ToIstanbul().toIstanbul()`, typed as `unknown` so the parser
 * is exercised the way the collector calls it.
 */
function istanbulEntry(options: {
  statements: { line: number; count: number }[];
  functions: { name: string; line: number; count: number }[];
  branches: { lines: number[]; counts: number[] }[];
}): unknown {
  const statementMap: Record<string, unknown> = {};
  const s: Record<string, number> = {};
  options.statements.forEach((statement, index) => {
    statementMap[String(index)] = loc(statement.line);
    s[String(index)] = statement.count;
  });

  const fnMap: Record<string, unknown> = {};
  const f: Record<string, number> = {};
  options.functions.forEach((fn, index) => {
    fnMap[String(index)] = { name: fn.name, decl: loc(fn.line), loc: loc(fn.line), line: fn.line };
    f[String(index)] = fn.count;
  });

  const branchMap: Record<string, unknown> = {};
  const b: Record<string, number[]> = {};
  options.branches.forEach((branch, index) => {
    branchMap[String(index)] = {
      type: 'branch',
      line: branch.lines[0],
      locations: branch.lines.map(loc),
    };
    b[String(index)] = branch.counts;
  });

  return { path: '/repo/file.ts', all: false, statementMap, s, fnMap, f, branchMap, b };
}

function parsed(value: unknown): IstanbulFileCoverage {
  const result = parseIstanbulFileCoverage(value);
  if (result === null) throw new Error('expected the istanbul entry to parse');
  return result;
}

describe('isCoverageShardFile', () => {
  it('accepts the per-suite shards and the legacy single-suite name', () => {
    expect(isCoverageShardFile('coverage.json')).toBe(true);
    expect(isCoverageShardFile('coverage-views-core.json')).toBe(true);
    expect(isCoverageShardFile('coverage-gcp_provider.json')).toBe(true);
  });

  it('rejects anything else in the spool directory', () => {
    expect(isCoverageShardFile('coverage-.json')).toBe(false);
    expect(isCoverageShardFile('coverage.json.tmp')).toBe(false);
    expect(isCoverageShardFile('lcov.info')).toBe(false);
    expect(isCoverageShardFile('nested/coverage.json')).toBe(false);
  });
});

describe('isRendererBundleUrl', () => {
  it('accepts the Vite renderer bundle', () => {
    expect(isRendererBundleUrl('file:///app/out/renderer/assets/index-a1b2c3.js')).toBe(true);
  });

  it('rejects every other script V8 reports', () => {
    expect(isRendererBundleUrl('file:///app/out/renderer/assets/index-a1b2c3.css')).toBe(false);
    expect(isRendererBundleUrl('file:///app/out/renderer/assets/vendor-a1b2c3.js')).toBe(false);
    expect(isRendererBundleUrl('file:///app/out/preload/preload.js')).toBe(false);
    expect(isRendererBundleUrl('node:internal/bootstrap')).toBe(false);
  });
});

describe('isProjectSourcePath', () => {
  it('accepts workspace sources', () => {
    expect(isProjectSourcePath('packages/ui/src/App.tsx')).toBe(true);
    expect(isProjectSourcePath('packages/core/src/types/config.ts')).toBe(true);
  });

  it('rejects dependencies and files outside the workspaces', () => {
    expect(isProjectSourcePath('node_modules/react/index.js')).toBe(false);
    expect(isProjectSourcePath('packages/ui/node_modules/visx/index.js')).toBe(false);
    expect(isProjectSourcePath('e2e/helpers.ts')).toBe(false);
    expect(isProjectSourcePath('../outside/src/x.ts')).toBe(false);
  });
});

describe('parseIstanbulFileCoverage', () => {
  it('narrows a v8-to-istanbul entry to the fields lcov needs', () => {
    const entry = parsed(
      istanbulEntry({
        statements: [
          { line: 1, count: 1 },
          { line: 2, count: 0 },
        ],
        functions: [{ name: 'render', line: 1, count: 3 }],
        branches: [{ lines: [2], counts: [1] }],
      }),
    );

    expect(entry.statements).toEqual([
      { line: 1, count: 1 },
      { line: 2, count: 0 },
    ]);
    expect(entry.functions).toEqual([{ name: 'render', line: 1, count: 3 }]);
    expect(entry.branches).toEqual([{ locations: [{ line: 2, count: 1 }] }]);
  });

  it('names unnamed functions after their fnMap id', () => {
    const entry = parsed(
      istanbulEntry({
        statements: [],
        functions: [{ name: '', line: 7, count: 0 }],
        branches: [],
      }),
    );

    expect(entry.functions).toEqual([{ name: 'anon_0', line: 7, count: 0 }]);
  });

  it('treats a missing count as never executed', () => {
    const entry = parsed({
      statementMap: { '0': loc(1), '1': loc(2) },
      fnMap: { '0': { name: 'run', loc: loc(1) } },
      branchMap: { '0': { locations: [loc(2), loc(3)] } },
      // No s / f / b at all, and only a partial count list for the branch.
      b: { '0': [4] },
    });

    expect(entry.statements).toEqual([
      { line: 1, count: 0 },
      { line: 2, count: 0 },
    ]);
    expect(entry.functions).toEqual([{ name: 'run', line: 1, count: 0 }]);
    expect(entry.branches).toEqual([
      {
        locations: [
          { line: 2, count: 4 },
          { line: 3, count: 0 },
        ],
      },
    ]);
  });

  it('returns null for anything that is not a file entry', () => {
    expect(parseIstanbulFileCoverage(null)).toBeNull();
    expect(parseIstanbulFileCoverage('coverage')).toBeNull();
    expect(parseIstanbulFileCoverage([])).toBeNull();
    expect(parseIstanbulFileCoverage({})).toBeNull();
    // branchMap is an array rather than a record — not the shape we expect.
    expect(parseIstanbulFileCoverage({ statementMap: {}, fnMap: {}, branchMap: [] })).toBeNull();
  });
});

describe('mergeIstanbulFile', () => {
  it('takes the highest count each shard reported', () => {
    const report = createCoverageReport();
    const path = '/repo/packages/ui/src/App.tsx';

    mergeIstanbulFile(
      report,
      path,
      parsed(
        istanbulEntry({
          statements: [
            { line: 1, count: 1 },
            { line: 2, count: 0 },
          ],
          functions: [{ name: 'render', line: 1, count: 0 }],
          branches: [],
        }),
      ),
    );
    mergeIstanbulFile(
      report,
      path,
      parsed(
        istanbulEntry({
          statements: [
            { line: 1, count: 0 },
            { line: 2, count: 5 },
          ],
          functions: [{ name: 'render', line: 1, count: 2 }],
          branches: [],
        }),
      ),
    );

    const merged = report.get(path);
    expect(merged?.lines.get(1)).toBe(1);
    expect(merged?.lines.get(2)).toBe(5);
    expect(merged?.functions.get('render:1')).toEqual({ line: 1, count: 2 });
  });

  it('keeps files separate and restarts block ids per file', () => {
    const report = createCoverageReport();
    const entry = parsed(
      istanbulEntry({
        statements: [{ line: 1, count: 1 }],
        functions: [],
        branches: [
          { lines: [1], counts: [1] },
          { lines: [2], counts: [0] },
        ],
      }),
    );

    mergeIstanbulFile(report, '/repo/packages/ui/src/A.tsx', entry);
    mergeIstanbulFile(report, '/repo/packages/ui/src/B.tsx', entry);

    expect(report.size).toBe(2);
    expect(report.get('/repo/packages/ui/src/A.tsx')?.branches).toEqual([
      { line: 1, blockId: 0, branchId: 0, count: 1 },
      { line: 2, blockId: 1, branchId: 0, count: 0 },
    ]);
    expect(report.get('/repo/packages/ui/src/B.tsx')?.branches).toEqual(
      report.get('/repo/packages/ui/src/A.tsx')?.branches,
    );
  });
});

describe('generateLcov', () => {
  it('renders a file record lcov parsers accept', () => {
    const report = createCoverageReport();
    mergeIstanbulFile(
      report,
      'packages/ui/src/App.tsx',
      parsed(
        istanbulEntry({
          statements: [
            { line: 1, count: 1 },
            { line: 2, count: 0 },
            { line: 3, count: 2 },
          ],
          functions: [{ name: 'render', line: 1, count: 3 }],
          branches: [
            { lines: [2], counts: [1] },
            { lines: [3], counts: [0] },
          ],
        }),
      ),
    );

    expect(generateLcov(report)).toBe(
      [
        'TN:',
        'SF:packages/ui/src/App.tsx',
        'FN:1,render',
        'FNF:1',
        'FNH:1',
        'FNDA:3,render',
        'DA:1,1',
        'DA:2,0',
        'DA:3,2',
        'LF:3',
        'LH:2',
        'BRDA:2,0,0,1',
        'BRDA:3,1,0,-',
        'BRF:2',
        'BRH:1',
        'end_of_record',
      ].join('\n') + '\n',
    );
  });

  it('emits lines in ascending order regardless of merge order', () => {
    const report = createCoverageReport();
    mergeIstanbulFile(
      report,
      'packages/core/src/x.ts',
      parsed(
        istanbulEntry({
          statements: [
            { line: 12, count: 1 },
            { line: 3, count: 1 },
            { line: 7, count: 0 },
          ],
          functions: [],
          branches: [],
        }),
      ),
    );

    const daLines = generateLcov(report)
      .split('\n')
      .filter(line => line.startsWith('DA:'));
    expect(daLines).toEqual(['DA:3,1', 'DA:7,0', 'DA:12,1']);
  });

  it('deduplicates a branch reported by several shards, keeping the max', () => {
    const report = createCoverageReport();
    const path = 'packages/core/src/x.ts';
    const shard = (count: number): unknown =>
      istanbulEntry({ statements: [], functions: [], branches: [{ lines: [4], counts: [count] }] });

    mergeIstanbulFile(report, path, parsed(shard(0)));
    mergeIstanbulFile(report, path, parsed(shard(6)));

    const lcov = generateLcov(report);
    expect(lcov).toContain('BRDA:4,0,0,6');
    expect(lcov).toContain('BRF:1');
    expect(lcov).toContain('BRH:1');
  });

  it('renders an empty report as a one-byte file, which is why emptiness is rejected separately', () => {
    // CI's `[ -s "$f" ]` merge guard accepts this as a valid shard.
    expect(generateLcov(createCoverageReport())).toBe('\n');
    expect(auditCoverageReport(createCoverageReport()).status).toBe('empty');
  });
});
