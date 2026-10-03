import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Profiler } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EncodedSourceMap } from '@jridgewell/trace-mapping';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addBundleEntry, createBundleCoverage } from '../e2e-coverage/bundle-coverage.js';
import { mappedSourceLines, parseSourceMap, zeroUnmappedLines } from '../e2e-coverage/source-map-lines.js';
import type { FileCoverage, IstanbulFileCoverage } from '../e2e-coverage/types.js';

const BUNDLE = '/repo/out/renderer/assets/index-abc.js';

// Decoded: generated line 1 → a.ts:1; line 2 → a.ts:3 plus a one-field
// segment that maps to no source; line 3 → b.ts:5.
const TWO_SOURCE_MAPPINGS = 'AAAA;AAEA,M;ACEA';

function map(fields: Partial<EncodedSourceMap> = {}): EncodedSourceMap {
  return { version: 3, names: [], mappings: TWO_SOURCE_MAPPINGS, sources: ['a.ts', 'b.ts'], ...fields };
}

function lines(sourceMap: EncodedSourceMap): ReadonlyMap<string, ReadonlySet<number>> {
  const result = mappedSourceLines(sourceMap, BUNDLE);
  if (result.status !== 'ok') throw new Error(result.reason);
  return result.lines;
}

describe('parseSourceMap', () => {
  it('keeps the fields v8-to-istanbul reads and does not check version', () => {
    expect(
      parseSourceMap({
        version: '3',
        mappings: 'AAAA',
        sources: ['a.ts'],
        sourcesContent: ['x', null],
        file: 'index.js',
        sourceRoot: 'src',
      }),
    ).toEqual({
      version: 3,
      mappings: 'AAAA',
      sources: ['a.ts'],
      names: [],
      sourcesContent: ['x', null],
      file: 'index.js',
      sourceRoot: 'src',
    });
  });

  it.each([
    ['not an object', 'nope'],
    ['no mappings string', { sources: ['a.ts'], mappings: [[0, 0, 0, 0]] }],
    ['no sources array', { sources: 'a.ts', mappings: '' }],
    ['a non-string source', { sources: ['a.ts', null], mappings: '' }],
  ])('refuses a map with %s', (_label, value) => {
    expect(parseSourceMap(value)).toBeNull();
  });
});

describe('mappedSourceLines', () => {
  it('lists, per source, the original lines some segment maps to', () => {
    expect(lines(map())).toEqual(
      new Map([
        ['/repo/out/renderer/assets/a.ts', new Set([1, 3])],
        ['/repo/out/renderer/assets/b.ts', new Set([5])],
      ]),
    );
  });

  it('keeps a source the bundle has no code for, with no lines', () => {
    const result = lines(map({ sources: ['a.ts', 'b.ts', 'c.ts'] }));
    expect(result.get('/repo/out/renderer/assets/c.ts')).toEqual(new Set());
  });

  it('resolves sources the way v8-to-istanbul files them', () => {
    const sources = ['../../../ui/src/a.tsx', 'file:///abs/b.ts', '/abs/d.ts'];
    expect([...lines(map({ sources })).keys()]).toEqual(['/repo/ui/src/a.tsx', '/abs/b.ts', '/abs/d.ts']);
  });

  it('files a one-source map under its source, its file, or the bundle itself', () => {
    const keys = (fields: Partial<EncodedSourceMap>): string[] => [...lines(map(fields)).keys()];
    expect(keys({ sources: ['a.ts'], mappings: 'AAAA' })).toEqual(['/repo/out/renderer/assets/a.ts']);
    expect(keys({ sources: ['a.ts'], sourceRoot: '../src', mappings: 'AAAA' })).toEqual([
      '/repo/out/renderer/src/a.ts',
    ]);
    expect(keys({ sources: [''], mappings: '' })).toEqual([BUNDLE]);
    expect(keys({ sources: [], mappings: '', file: 'facade.js' })).toEqual(['/repo/out/renderer/assets/facade.js']);
    expect(lines(map({ sources: [], mappings: '' }))).toEqual(new Map([[BUNDLE, new Set()]]));
  });

  it.each([
    ['a sourceRoot', map({ sourceRoot: '../src' }), 'would credit its coverage to another file'],
    ['a webpack:// source', map({ sources: ['webpack://c.ts', 'b.ts'] }), 'another file'],
    ['two sources resolving to one path', map({ sources: ['a.ts', './a.ts'] }), 'one path'],
    ['a file URL with a host', map({ sources: ['file://host/a.ts', 'b.ts'] }), 'host'],
  ])('refuses a multi-source map with %s, which v8-to-istanbul mis-attributes', (_label, sourceMap, reason) => {
    const result = mappedSourceLines(sourceMap, BUNDLE);
    expect(result.status).toBe('unsupported');
    expect(result.status === 'unsupported' ? result.reason : '').toContain(reason);
  });
});

describe('zeroUnmappedLines', () => {
  const data: IstanbulFileCoverage = {
    statements: [
      { line: 1, count: 1 },
      { line: 2, count: 1 },
      { line: 3, count: 0 },
      { line: 4, count: 7 },
    ],
    functions: [{ name: 'f', line: 1, count: 1 }],
    branches: [{ blockId: 0, locations: [{ branchId: 0, line: 4, count: 7 }] }],
  };

  it('zeroes every statement on a line with no mapping and keeps the rest', () => {
    expect(zeroUnmappedLines(data, new Set([1, 4])).statements).toEqual([
      { line: 1, count: 1 },
      { line: 2, count: 0 },
      { line: 3, count: 0 },
      { line: 4, count: 7 },
    ]);
  });

  it('leaves functions and branches alone', () => {
    const zeroed = zeroUnmappedLines(data, new Set());
    expect(zeroed.statements.map(statement => statement.count)).toEqual([0, 0, 0, 0]);
    expect(zeroed.functions).toBe(data.functions);
    expect(zeroed.branches).toBe(data.branches);
  });
});

// The premise of the fix and the path contract it depends on, checked against
// a real tree-shaken vite bundle and the v8-to-istanbul the collector uses.
describe('addBundleEntry against a tree-shaken vite bundle', () => {
  const LIB = [
    'export interface Shape {', // 1
    '  readonly id: string;', // 2
    '}', // 3
    'export function used(shape: Shape): number {', // 4
    '  return shape.id.length;', // 5
    '}', // 6
    'export function unused(): number {', // 7
    '  return 2;', // 8
    '}', // 9
    '',
  ].join('\n');
  const ENTRY = "import { used } from './lib';\nused({ id: 'abc' });\n";

  let dir = '';
  let bundlePath = '';
  let code = '';
  let sourceMapText = '';

  beforeAll(async () => {
    // Real path: vite resolves its root through symlinks (macOS /var → /private/var).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'costgoblin-source-map-lines-')));
    writeFileSync(join(dir, 'lib.ts'), LIB);
    writeFileSync(join(dir, 'entry.ts'), ENTRY);
    const output = await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      // No tsconfig lookup: it would walk up past `root` into tmpdir's ancestors.
      esbuild: { tsconfigRaw: '{}' },
      build: { write: false, sourcemap: true, minify: false, rollupOptions: { input: join(dir, 'entry.ts') } },
    });
    if (Array.isArray(output) || !('output' in output)) throw new Error('vite returned no bundle');
    const [chunk] = output.output;
    if (chunk.map === null) throw new Error('vite produced no source map');
    bundlePath = join(dir, 'dist', chunk.fileName);
    code = chunk.code;
    sourceMapText = chunk.map.toString();
  }, 30_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The whole script ran once: a bundle that loaded and called `used`.
  const ranAll = (script: string): Profiler.FunctionCoverage[] => [
    { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: script.length, count: 1 }] },
  ];

  const countAt = (file: FileCoverage | undefined, line: number): number | undefined => file?.lines.get(line);

  it('tree-shakes the unused export out of the bundle', () => {
    expect(code).toContain('shape.id.length');
    expect(code).not.toContain('return 2');
  });

  it('credits the tree-shaken lines in the raw report and zeroes them in the published one', async () => {
    const coverage = createBundleCoverage();
    const added = await addBundleEntry(coverage, {
      bundlePath,
      code,
      sourceMapText,
      functions: ranAll(code),
      isProjectFile: () => true,
    });
    expect(added).toEqual({ status: 'ok' });
    // Every v8-to-istanbul entry was found under a path mappedSourceLines returns.
    expect([...coverage.raw.keys()].sort()).toEqual([join(dir, 'entry.ts'), join(dir, 'lib.ts')]);

    const lib = join(dir, 'lib.ts');
    // v8-to-istanbul is subtractive: no range lands on code the bundle lacks.
    expect(countAt(coverage.raw.get(lib), 8)).toBe(1);
    expect(countAt(coverage.zeroed.get(lib), 5)).toBe(1);
    for (const line of [7, 8, 9]) expect(countAt(coverage.zeroed.get(lib), line)).toBe(0);
    expect(coverage.mappedLines.get(lib)?.has(5)).toBe(true);
    expect(coverage.mappedLines.get(lib)?.has(8)).toBe(false);
  });

  it('folds in only the files the caller keeps', async () => {
    const coverage = createBundleCoverage();
    await addBundleEntry(coverage, {
      bundlePath,
      code,
      sourceMapText,
      functions: ranAll(code),
      isProjectFile: filePath => filePath.endsWith('lib.ts'),
    });
    expect([...coverage.zeroed.keys()]).toEqual([join(dir, 'lib.ts')]);
  });

  it.each([
    ['a source map that is not JSON', '{', 'not a JSON source map'],
    ['a map v8-to-istanbul would mis-attribute', JSON.stringify({ mappings: '', sources: ['a.ts', 'a.ts'] }), 'one path'],
  ])('refuses %s and folds in nothing', async (_label, text, message) => {
    const coverage = createBundleCoverage();
    const added = await addBundleEntry(coverage, {
      bundlePath,
      code,
      sourceMapText: text,
      functions: ranAll(code),
      isProjectFile: () => true,
    });
    expect(added.status === 'error' ? added.message : '').toContain(message);
    expect(coverage.raw.size).toBe(0);
  });

  it('files a zero-source facade chunk where v8-to-istanbul does', async () => {
    const facade = join(dir, 'index-facade.js');
    const facadeCode = "export { used } from './index-abc.js';\n";
    writeFileSync(facade, facadeCode);
    const coverage = createBundleCoverage();
    const added = await addBundleEntry(coverage, {
      bundlePath: facade,
      code: facadeCode,
      sourceMapText: JSON.stringify({ version: 3, file: 'index-facade.js', sources: [], names: [], mappings: ';' }),
      functions: ranAll(facadeCode),
      isProjectFile: () => true,
    });
    expect(added).toEqual({ status: 'ok' });
    expect(countAt(coverage.zeroed.get(facade), 1)).toBe(0);
  });
});
