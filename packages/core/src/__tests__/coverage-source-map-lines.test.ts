import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EncodedSourceMap } from '@jridgewell/trace-mapping';
import v8ToIstanbul from 'v8-to-istanbul';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseIstanbulFileCoverage } from '../e2e-coverage/collect.js';
import { mappedSourceLines, zeroUnmappedLines } from '../e2e-coverage/source-map-lines.js';
import type { IstanbulFileCoverage } from '../e2e-coverage/types.js';

const BUNDLE = '/repo/out/renderer/assets/index-abc.js';

// Decoded: generated line 1 → a.ts:1; line 2 → a.ts:3 plus a one-field
// segment that maps to no source; line 3 → b.ts:5.
const TWO_SOURCE_MAPPINGS = 'AAAA;AAEA,M;ACEA';

function map(fields: Record<string, unknown>): Record<string, unknown> {
  return { version: 3, names: [], mappings: TWO_SOURCE_MAPPINGS, sources: ['a.ts', 'b.ts'], ...fields };
}

describe('mappedSourceLines', () => {
  it('lists, per source, the original lines some segment maps to', () => {
    const lines = mappedSourceLines(map({}), BUNDLE);
    expect(lines).toEqual(
      new Map([
        ['/repo/out/renderer/assets/a.ts', new Set([1, 3])],
        ['/repo/out/renderer/assets/b.ts', new Set([5])],
      ]),
    );
  });

  it('keeps a source the bundle has no code for, with no lines', () => {
    const lines = mappedSourceLines(map({ sources: ['a.ts', 'b.ts', 'c.ts'] }), BUNDLE);
    expect(lines?.get('/repo/out/renderer/assets/c.ts')).toEqual(new Set());
  });

  it('resolves sources the way v8-to-istanbul files them', () => {
    const sources = [
      '../../../ui/src/a.tsx',
      'file:///abs/b.ts',
      'webpack://c.ts',
      '/abs/d.ts',
    ];
    const lines = mappedSourceLines(map({ sources }), BUNDLE);
    expect([...(lines?.keys() ?? [])]).toEqual([
      '/repo/ui/src/a.tsx',
      '/abs/b.ts',
      '/repo/out/renderer/assets/c.ts',
      '/abs/d.ts',
    ]);
  });

  it('applies sourceRoot, with or without a file:// prefix', () => {
    expect([...(mappedSourceLines(map({ sourceRoot: '../src' }), BUNDLE)?.keys() ?? [])]).toEqual([
      '/repo/out/renderer/src/a.ts',
      '/repo/out/renderer/src/b.ts',
    ]);
    expect([...(mappedSourceLines(map({ sourceRoot: 'file:///root' }), BUNDLE)?.keys() ?? [])]).toEqual([
      '/root/a.ts',
      '/root/b.ts',
    ]);
  });

  it('unions two sources that resolve to the same path', () => {
    const lines = mappedSourceLines(map({ sources: ['a.ts', './a.ts'] }), BUNDLE);
    expect(lines).toEqual(new Map([['/repo/out/renderer/assets/a.ts', new Set([1, 3, 5])]]));
  });

  it.each([
    ['not an object', 'nope'],
    ['a version other than 3', map({ version: 2 })],
    ['no mappings string', map({ mappings: undefined })],
    ['no sources array', map({ sources: 'a.ts' })],
    ['a non-string source', map({ sources: ['a.ts', null] })],
  ])('refuses a map with %s', (_label, value) => {
    expect(mappedSourceLines(value, BUNDLE)).toBeNull();
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

  it('never raises a count, and leaves functions and branches alone', () => {
    const zeroed = zeroUnmappedLines(data, new Set([3]));
    for (const [index, statement] of zeroed.statements.entries()) {
      expect(statement.count).toBeLessThanOrEqual(data.statements[index]?.count ?? 0);
    }
    expect(zeroed.functions).toBe(data.functions);
    expect(zeroed.branches).toBe(data.branches);
  });
});

// The premise of the fix and the path contract it depends on, checked against
// a real tree-shaken vite bundle and the v8-to-istanbul the collector uses.
describe('against a tree-shaken vite bundle and v8-to-istanbul', () => {
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
  let sourceMap: EncodedSourceMap | null = null;

  beforeAll(async () => {
    // Real path: vite resolves its root through symlinks (macOS /var → /private/var).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'costgoblin-source-map-lines-')));
    writeFileSync(join(dir, 'lib.ts'), LIB);
    writeFileSync(join(dir, 'entry.ts'), ENTRY);
    const output = await build({
      root: dir,
      configFile: false,
      logLevel: 'silent',
      build: { write: false, sourcemap: true, minify: false, rollupOptions: { input: join(dir, 'entry.ts') } },
    });
    const outputs = Array.isArray(output) ? output : [output];
    for (const result of outputs) {
      if (!('output' in result)) continue;
      for (const chunk of result.output) {
        if (chunk.type !== 'chunk') continue;
        bundlePath = join(dir, 'dist', chunk.fileName);
        code = chunk.code;
        if (chunk.map === null) continue;
        const { sources, sourcesContent, names, mappings } = chunk.map;
        sourceMap = { version: 3, sources, sourcesContent: sourcesContent ?? [], names, mappings };
      }
    }
  }, 30_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function convert(): Promise<Map<string, IstanbulFileCoverage>> {
    if (sourceMap === null) throw new Error('vite produced no source map');
    // `originalSource` is only read for a one-source map without
    // sourcesContent; this one has two sources and their content.
    const converter = v8ToIstanbul(bundlePath, 0, {
      source: code,
      originalSource: '',
      sourceMap: { sourcemap: sourceMap },
    });
    await converter.load();
    // The whole script ran once, as a bundle that loaded and called `used`.
    converter.applyCoverage([
      {
        functionName: '',
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: code.length, count: 1 }],
      },
    ]);
    const result = new Map<string, IstanbulFileCoverage>();
    for (const [path, value] of Object.entries(converter.toIstanbul())) {
      const parsed = parseIstanbulFileCoverage(value);
      if (parsed === null) throw new Error(`unparseable entry for ${path}`);
      result.set(path, parsed);
    }
    return result;
  }

  const countAt = (data: IstanbulFileCoverage | undefined, line: number): number | undefined =>
    data?.statements.find(statement => statement.line === line)?.count;

  it('tree-shakes the unused export out of the bundle', () => {
    expect(code).toContain('shape.id.length');
    expect(code).not.toContain('return 2');
  });

  it('files every v8-to-istanbul entry under a path mappedSourceLines returns', async () => {
    const lines = mappedSourceLines(sourceMap, bundlePath);
    const entries = await convert();
    expect(entries.size).toBeGreaterThan(1);
    expect([...entries.keys()].sort()).toEqual([...(lines?.keys() ?? [])].sort());
    expect(lines?.has(join(dir, 'lib.ts'))).toBe(true);
  });

  it('credits the tree-shaken lines as covered until they are zeroed', async () => {
    const lib = (await convert()).get(join(dir, 'lib.ts'));
    // v8-to-istanbul is subtractive: no range lands on code the bundle lacks.
    expect(countAt(lib, 8)).toBe(1);

    const mapped = mappedSourceLines(sourceMap, bundlePath)?.get(join(dir, 'lib.ts'));
    if (lib === undefined || mapped === undefined) throw new Error('lib.ts missing');
    expect(mapped.has(5)).toBe(true);
    expect([7, 8, 9].some(line => mapped.has(line))).toBe(false);

    const zeroed = zeroUnmappedLines(lib, mapped);
    expect(countAt(zeroed, 5)).toBe(1);
    expect(countAt(zeroed, 7)).toBe(0);
    expect(countAt(zeroed, 8)).toBe(0);
    expect(countAt(zeroed, 9)).toBe(0);
  });
});
