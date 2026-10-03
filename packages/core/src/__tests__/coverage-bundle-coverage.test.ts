import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { Profiler } from 'node:inspector';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addBundleEntry,
  type BundleCoverage,
  type BundleEntry,
  branchesOfPreAttachFunctions,
  createBundleCoverage,
  parseSourceMap,
  withoutIgnoreFileHints,
} from '../e2e-coverage/bundle-coverage.js';
import type { FileCoverage } from '../e2e-coverage/types.js';
import { isStringRecord } from '../utils/json.js';

describe('parseSourceMap', () => {
  it('keeps the fields both converters read and does not check version', () => {
    expect(
      parseSourceMap({ version: '3', mappings: 'AAAA', sources: ['a.ts'], sourcesContent: ['x', null], file: 'index.js' }),
    ).toEqual({ version: 3, mappings: 'AAAA', sources: ['a.ts'], names: [], sourcesContent: ['x', null], file: 'index.js' });
  });

  it.each([
    ['not an object', 'nope'],
    ['no mappings string', { sources: ['a.ts'], mappings: [[0, 0, 0, 0]] }],
    ['no sources array', { sources: 'a.ts', mappings: '' }],
    ['a non-string source', { sources: ['a.ts', null], mappings: '' }],
    ['a sourceRoot', { sources: ['a.ts'], mappings: '', sourceRoot: '../src' }],
  ])('refuses a map with %s', (_label, value) => {
    expect(parseSourceMap(value)).toBeNull();
  });

  it.each([['an empty', ''], ['a null', null]])('accepts %s sourceRoot, which resolves nothing', (_label, sourceRoot) => {
    expect(parseSourceMap({ sources: ['a.ts'], mappings: '', sourceRoot })).not.toBeNull();
  });
});

describe('withoutIgnoreFileHints', () => {
  it('blanks every ignore-file hint without moving an offset or a line', () => {
    const code = [
      'a();',
      '/* istanbul ignore file */ b();',
      '// c8 ignore file because',
      '/* v8 ignore file -- @preserve',
      '   spanning lines */ c();',
      '/* istanbul ignore next */ d();',
    ].join('\n');

    const blanked = withoutIgnoreFileHints(code);

    expect(blanked).toHaveLength(code.length);
    expect(blanked.split('\n').map(line => line.trim())).toEqual(['a();', 'b();', '', '', 'c();', '/* istanbul ignore next */ d();']);
  });
});

describe('branchesOfPreAttachFunctions', () => {
  const branch = (start: number): { type: string; start: number } => ({ type: 'IfStatement', start });

  it('is not needed when every function that ran was measured block by block', () => {
    expect(
      branchesOfPreAttachFunctions([
        { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 100, count: 1 }] },
        { functionName: 'stale', isBlockCoverage: false, ranges: [{ startOffset: 10, endOffset: 20, count: 0 }] },
      ]),
    ).toBeUndefined();
  });

  it('skips the branches whose innermost function ran but was compiled before the attach', () => {
    const ignore = branchesOfPreAttachFunctions([
      { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: 100, count: 2 }] },
      {
        functionName: 'measured',
        isBlockCoverage: true,
        ranges: [{ startOffset: 40, endOffset: 60, count: 1 }, { startOffset: 50, endOffset: 55, count: 0 }],
      },
    ]);
    if (ignore === undefined) throw new Error('expected a filter');

    expect(ignore(branch(5), 'branch')).toBe(true);
    expect(ignore(branch(45), 'branch')).toBe(false);
    expect(ignore(branch(5), 'statement')).toBe(false);
    expect(ignore(branch(150), 'branch')).toBe(false);
  });
});

// The converter swap checked end to end: a real tree-shaken vite bundle, run
// by a real V8 with block coverage, converted by both libraries the collector
// uses.
describe('addBundleEntry against a vite bundle V8 actually ran', () => {
  const LIB = [
    'export interface Handlers {', // 1
    '  readonly onClick: () => void;', // 2
    '}', // 3
    'export function render(log: (message: string) => void, flag: boolean): Handlers {', // 4
    "  log('rendered');", // 5
    '  if (flag) {', // 6
    "    log('flagged');", // 7
    '  }', // 8
    '  return {', // 9
    "    onClick: () => { log('clicked'); },", // 10 — never called
    '  };', // 11
    '}', // 12
    'export function unused(): number {', // 13 — tree-shaken
    '  return 2;', // 14
    '}', // 15
    '',
  ].join('\n');
  // Side effects and a runtime flag, so rollup can neither drop the call nor
  // fold the `if` away.
  const ENTRY = [
    "import { render } from './lib';",
    'const seen: string[] = [];',
    "Reflect.set(globalThis, 'handlers', render(message => { seen.push(message); }, process.argv.length > 99));",
    "Reflect.set(globalThis, 'seen', seen);",
    '',
  ].join('\n');

  let dir = '';
  let lib = '';
  let entry: Omit<BundleEntry, 'isProjectFile'> = { bundlePath: '', code: '', sourceMapText: '', functions: [] };

  beforeAll(async () => {
    // Real path: vite resolves its root through symlinks (macOS /var → /private/var).
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'costgoblin-bundle-coverage-')));
    lib = join(dir, 'lib.ts');
    writeFileSync(lib, LIB);
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

    // `.mjs` beside where vite would have written it, so the map's relative
    // sources still resolve and node runs it as a module.
    const bundlePath = join(dir, 'dist', chunk.fileName.replace(/\.js$/, '.mjs'));
    mkdirSync(join(bundlePath, '..'), { recursive: true });
    writeFileSync(bundlePath, chunk.code);
    const coverageDir = join(dir, 'v8');
    execFileSync(process.execPath, [bundlePath], { env: { ...process.env, NODE_V8_COVERAGE: coverageDir } });
    const url = pathToFileURL(bundlePath).href;
    const scripts = readdirSync(coverageDir).flatMap((file): unknown[] => {
      const dump: unknown = JSON.parse(readFileSync(join(coverageDir, file), 'utf-8'));
      return isStringRecord(dump) && Array.isArray(dump['result']) ? dump['result'] : [];
    });
    const script = scripts.find(
      (candidate): candidate is Profiler.ScriptCoverage => isStringRecord(candidate) && candidate['url'] === url,
    );
    if (script === undefined) throw new Error('V8 reported no coverage for the bundle');
    entry = { bundlePath, code: chunk.code, sourceMapText: chunk.map.toString(), functions: script.functions };
  }, 30_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const countAt = (file: FileCoverage | undefined, line: number): number | undefined => file?.lines.get(line);

  async function convert(fields: Partial<BundleEntry> = {}): Promise<BundleCoverage> {
    const coverage = createBundleCoverage();
    const added = await addBundleEntry(coverage, { ...entry, isProjectFile: () => true, ...fields });
    expect(added).toEqual({ status: 'ok' });
    return coverage;
  }

  it('tree-shakes the unused export out of the bundle', () => {
    expect(entry.code).toContain('log("clicked")');
    expect(entry.code).not.toContain('return 2');
  });

  it('publishes a never-called one-line arrow at 0 where v8-to-istanbul credits it', async () => {
    const coverage = await convert();
    // The arrow's count-0 range covers only part of line 10, so the
    // subtractive converter leaves the line at 1.
    expect(countAt(coverage.raw.get(lib), 10)).toBe(1);
    expect(countAt(coverage.measured.get(lib), 10)).toBe(0);
    // What did run is credited by both.
    expect(countAt(coverage.raw.get(lib), 5)).toBe(1);
    expect(countAt(coverage.measured.get(lib), 5)).toBe(1);
  });

  it('credits the untaken branch of a statement that ran with nothing', async () => {
    const coverage = await convert();
    expect(countAt(coverage.measured.get(lib), 6)).toBe(1);
    expect(countAt(coverage.measured.get(lib), 7)).toBe(0);
    const ifBranch = coverage.measured.get(lib)?.branches.filter(branch => branch.line === 6) ?? [];
    // The taken implicit else keeps its location on the `if` line.
    expect(ifBranch.map(branch => branch.count)).toEqual([0, 1]);
  });

  it('reports no record for source the bundle has no code for, which v8-to-istanbul credits', async () => {
    const coverage = await convert();
    expect(countAt(coverage.raw.get(lib), 14)).toBe(1);
    expect(coverage.measured.get(lib)?.lines.has(14)).toBe(false);
    // Nor for the interface and the signature lines.
    for (const line of [1, 2, 4, 13]) expect(coverage.measured.get(lib)?.lines.has(line)).toBe(false);
  });

  it('numbers the published branches from the AST, whatever ranges V8 reported', async () => {
    const full = await convert();
    const topLevelOnly = await convert({
      functions: [
        { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: entry.code.length, count: 1 }] },
      ],
    });
    const keys = (coverage: BundleCoverage): string[] =>
      (coverage.measured.get(lib)?.branches ?? []).map(b => `${String(b.line)}:${String(b.blockId)}:${String(b.branchId)}`);
    expect(keys(topLevelOnly)).toEqual(keys(full));
    expect(keys(full).length).toBeGreaterThan(0);
  });

  it('publishes no branch of code V8 reports compiled before the attach, but keeps its statements', async () => {
    // The whole bundle as one range with no blocks inside: compiled before
    // coverage started, run since. `if (flag)`'s untaken arm reads taken.
    const coverage = await convert({
      functions: [
        { functionName: '', isBlockCoverage: false, ranges: [{ startOffset: 0, endOffset: entry.code.length, count: 1 }] },
      ],
    });
    expect(coverage.raw.get(lib)?.lines.get(7)).toBe(1);
    expect(coverage.measured.get(lib)?.branches).toEqual([]);
    expect(countAt(coverage.measured.get(lib), 5)).toBe(1);
  });

  it('converts a bundle that kept an ignore-file hint from one of its modules', async () => {
    const coverage = await convert({ code: `${entry.code}/* istanbul ignore file */\n` });
    expect(countAt(coverage.measured.get(lib), 10)).toBe(0);
    expect(countAt(coverage.measured.get(lib), 5)).toBe(1);
  });

  it('files both reports under the same project paths, and only those the caller keeps', async () => {
    const coverage = await convert({ isProjectFile: filePath => filePath.endsWith('lib.ts') });
    expect([...coverage.raw.keys()]).toEqual([lib]);
    expect([...coverage.measured.keys()]).toEqual([lib]);
  });

  it.each([
    ['a source map that is not JSON', () => '{', 'not a JSON source map'],
    ['a source map with a sourceRoot', (text: string) => JSON.stringify({ ...JSON.parse(text), sourceRoot: 'src' }), 'no sourceRoot'],
    [
      'a source the converters resolve differently',
      (text: string) => JSON.stringify({ ...JSON.parse(text), sources: ['webpack://lib.ts', '../entry.ts'] }),
      'disagree on the project files',
    ],
  ])('refuses %s and folds in nothing', async (_label, rewrite, message) => {
    const coverage = createBundleCoverage();
    const added = await addBundleEntry(coverage, {
      ...entry,
      sourceMapText: rewrite(entry.sourceMapText),
      isProjectFile: () => true,
    });
    expect(added.status).toBe('error');
    expect(added.status === 'error' ? added.message : '').toContain(message);
    expect(coverage.raw.size).toBe(0);
    expect(coverage.measured.size).toBe(0);
  });

  it('refuses a published conversion that credits nothing V8 reported running', async () => {
    // One executed range that no statement starts in: what the converter sees
    // when V8's offsets stop lining up with the AST's.
    const coverage = createBundleCoverage();
    const added = await addBundleEntry(coverage, {
      ...entry,
      functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 1, count: 1 }] }],
      isProjectFile: () => true,
    });
    expect(added.status === 'error' ? added.message : '').toContain('credited no statement');
    expect(coverage.measured.size).toBe(0);
  });

  it('leaves an entry V8 reports nothing running in to the audit', async () => {
    const coverage = await convert({ functions: [] });
    expect(countAt(coverage.measured.get(lib), 5)).toBe(0);
  });

  it('folds in nothing, successfully, for a chunk with no sources', async () => {
    const coverage = await convert({
      code: "export { render } from './index.mjs';\n",
      sourceMapText: JSON.stringify({ version: 3, file: 'facade.js', sources: [], names: [], mappings: ';' }),
      functions: [],
    });
    expect(coverage.raw.size).toBe(0);
    expect(coverage.measured.size).toBe(0);
  });
});
