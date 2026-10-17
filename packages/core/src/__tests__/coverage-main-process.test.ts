import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { auditCoverageReport, describeMainCoverageFailure } from '../e2e-coverage/audit.js';
import { createCoverageReport, isCoverageShardFile } from '../e2e-coverage/collect.js';
import {
  isMainBundleUrl,
  isNodeCoverageDumpFile,
  parseNodeCoverageDump,
} from '../e2e-coverage/main-process.js';
import type { FileCoverage } from '../e2e-coverage/types.js';

const CHECKOUT = 'file:///home/runner/work/cost-goblin/cost-goblin';

describe('isNodeCoverageDumpFile', () => {
  it('accepts the names Node gives NODE_V8_COVERAGE dumps', () => {
    expect(isNodeCoverageDumpFile('coverage-86909-1792274028440-0.json')).toBe(true);
    // A worker thread's dump carries its thread id.
    expect(isNodeCoverageDumpFile('coverage-86909-1792274028440-3.json')).toBe(true);
  });

  it('rejects the renderer shards and anything else in the spool directory', () => {
    expect(isNodeCoverageDumpFile('coverage-views-core.json')).toBe(false);
    expect(isNodeCoverageDumpFile('coverage.json')).toBe(false);
    expect(isNodeCoverageDumpFile('coverage-86909-1792274028440.json')).toBe(false);
    expect(isNodeCoverageDumpFile('coverage-86909-1792274028440-0.json.tmp')).toBe(false);
    expect(isNodeCoverageDumpFile('main/coverage-86909-1792274028440-0.json')).toBe(false);
  });

  it('is why the dumps live in their own directory: the shard glob would take one for a shard', () => {
    // helpers.ts writes the dumps under V8_DIR/main, not beside the renderer
    // shards. If that ever changes, collect-coverage.ts would parse a Node
    // dump as a list of renderer entries.
    expect(isCoverageShardFile('coverage-86909-1792274028440-0.json')).toBe(true);
  });
});

describe('isMainBundleUrl', () => {
  it('accepts the electron-vite main bundle and its chunks', () => {
    expect(isMainBundleUrl(`${CHECKOUT}/packages/desktop/out/main/main.js`)).toBe(true);
    expect(isMainBundleUrl(`${CHECKOUT}/packages/desktop/out/main/index-DXft4Z24.js`)).toBe(true);
    // V8 reports file URLs, so a checkout path with a space arrives encoded.
    expect(isMainBundleUrl('file:///Users/o%20brien/cost-goblin/packages/desktop/out/main/main.js')).toBe(true);
  });

  it('rejects every other script a main-process dump lists', () => {
    expect(isMainBundleUrl(`${CHECKOUT}/packages/desktop/out/renderer/assets/index-B6A0Kxle.js`)).toBe(false);
    expect(isMainBundleUrl(`${CHECKOUT}/packages/desktop/out/worker/sync-worker.cjs`)).toBe(false);
    expect(isMainBundleUrl(`${CHECKOUT}/packages/desktop/out/main/main.js.map`)).toBe(false);
    expect(isMainBundleUrl(`${CHECKOUT}/node_modules/yaml/dist/index.js`)).toBe(false);
    expect(isMainBundleUrl('node:internal/bootstrap/node')).toBe(false);
    expect(isMainBundleUrl('electron/js2c/browser_init')).toBe(false);
    expect(isMainBundleUrl('https://example.com/packages/desktop/out/main/main.js')).toBe(false);
  });
});

describe('parseNodeCoverageDump', () => {
  // Real path: Node reports the module's resolved URL, and macOS's tmpdir is
  // a symlink (/var → /private/var).
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'costgoblin-node-dump-')));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Runs `code` in a real Node with NODE_V8_COVERAGE and returns the parsed
   *  dump, so the parser is checked against what Node actually writes rather
   *  than against a hand-written imitation of it. */
  function dumpOf(code: string): { script: string; dump: unknown } {
    const script = join(dir, 'probe.cjs');
    const spool = mkdtempSync(join(dir, 'spool-'));
    writeFileSync(script, code);
    execFileSync(process.execPath, [script], { env: { PATH: process.env['PATH'], NODE_V8_COVERAGE: spool } });
    const [file] = readdirSync(spool);
    if (file === undefined) throw new Error('Node wrote no coverage dump');
    expect(isNodeCoverageDumpFile(file)).toBe(true);
    const dump: unknown = JSON.parse(readFileSync(join(spool, file), 'utf-8'));
    return { script, dump };
  }

  it('reads a dump Node wrote, block counts included', () => {
    const { script, dump } = dumpOf(
      [
        "function used(n) { if (n > 1) { return 'big'; } return 'small'; }",
        'function unused() { return 42; }',
        'used(2);',
      ].join('\n'),
    );
    const scripts = parseNodeCoverageDump(dump);
    if (scripts === null) throw new Error('expected the dump to parse');

    const probe = scripts.find(entry => entry.url === pathToFileURL(script).href);
    if (probe === undefined) throw new Error('the dump does not list the probe script');
    const used = probe.functions.find(fn => fn.functionName === 'used');
    const unused = probe.functions.find(fn => fn.functionName === 'unused');
    if (used === undefined || unused === undefined) throw new Error('the probe functions are missing');

    // Measured from the first line: block coverage, with the `if` arm run
    // and the fall-through after it never reached.
    expect(used.isBlockCoverage).toBe(true);
    expect(used.ranges[0]?.count).toBe(1);
    expect(used.ranges.some(range => range.count === 0)).toBe(true);
    expect(unused.ranges[0]?.count).toBe(0);
  });

  it('rejects anything that is not a dump', () => {
    expect(parseNodeCoverageDump(null)).toBeNull();
    expect(parseNodeCoverageDump([])).toBeNull();
    expect(parseNodeCoverageDump({})).toBeNull();
    expect(parseNodeCoverageDump({ result: {} })).toBeNull();
  });

  it('rejects a dump with any malformed entry, not just the ones the collector keeps', () => {
    const fn = { functionName: 'f', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 9, count: 1 }] };
    const script = { scriptId: '1', url: 'node:internal/x', functions: [fn] };
    expect(parseNodeCoverageDump({ result: [script] })).toEqual([script]);

    expect(parseNodeCoverageDump({ result: [script, { ...script, url: 1 }] })).toBeNull();
    expect(parseNodeCoverageDump({ result: [{ ...script, scriptId: 1 }] })).toBeNull();
    expect(parseNodeCoverageDump({ result: [{ ...script, functions: 'none' }] })).toBeNull();
    expect(parseNodeCoverageDump({ result: [{ ...script, functions: [{ ...fn, functionName: 0 }] }] })).toBeNull();
    expect(parseNodeCoverageDump({ result: [{ ...script, functions: [{ ...fn, isBlockCoverage: 'yes' }] }] })).toBeNull();
    expect(parseNodeCoverageDump({ result: [{ ...script, functions: [{ ...fn, ranges: null }] }] })).toBeNull();
    expect(
      parseNodeCoverageDump({ result: [{ ...script, functions: [{ ...fn, ranges: [{ startOffset: 0, endOffset: 9 }] }] }] }),
    ).toBeNull();
  });
});

describe('describeMainCoverageFailure', () => {
  it('points an empty report at the bundle path, its source map and stale dumps', () => {
    const message = describeMainCoverageFailure({ status: 'empty' });
    expect(message).toContain('packages/desktop/out/main/');
    expect(message).toContain('--sourcemap');
    expect(message).toContain('newer than the bundle');
  });

  it('names the count and share of a fabricated report, and rules out the attach race', () => {
    const report = createCoverageReport();
    // 30 files no function was reported for, every line credited: the shape
    // the audit rejects.
    for (let i = 0; i < 30; i++) {
      const coverage: FileCoverage = { lines: new Map(), functions: new Map(), branches: [], statementEnds: new Map() };
      for (let line = 1; line <= 30; line++) coverage.lines.set(line, 1);
      report.set(`/repo/packages/core/src/types/t${String(i)}.ts`, coverage);
    }
    const verdict = auditCoverageReport(report);
    if (verdict.status !== 'fabricated') throw new Error(`expected a fabricated verdict, got "${verdict.status}"`);

    const message = describeMainCoverageFailure(verdict);
    expect(message).toContain('30 files of the main-process report');
    expect(message).toContain('100.0%');
    expect(message).toContain('not an attach race');
  });
});
