import type { Profiler } from 'node:inspector';
import { isStringRecord } from '../utils/json.js';

/**
 * The main process's side of the e2e coverage pipeline.
 *
 * The renderer is measured over CDP (Playwright's `page.coverage`), which can
 * only start once the window exists: that is the attach race `./audit.ts`
 * guards against. The main process is measured by Node itself instead.
 * `launchElectron` (e2e/helpers.ts) starts every app with `NODE_V8_COVERAGE`
 * pointing at a spool directory, so V8 records block coverage from the first
 * line of the bundle on and writes one dump per process as it exits. Nothing
 * attaches late. `closeApp` also flushes a dump (`v8.takeCoverage()`) just
 * before it asks the app to quit, since a launch it then has to SIGKILL
 * writes no exit dump: each launch leaves two dumps, the flushed one holding
 * everything up to the quit and the exit one holding the quit itself.
 */

/** Node names each dump `coverage-<pid>-<epoch ms>-<thread id>.json`. */
const NODE_COVERAGE_DUMP_FILE = /^coverage-\d+-\d+-\d+\.json$/;

/** True when `fileName` is a dump Node wrote for `NODE_V8_COVERAGE`. */
export function isNodeCoverageDumpFile(fileName: string): boolean {
  return NODE_COVERAGE_DUMP_FILE.test(fileName);
}

/**
 * True for the main-process bundle electron-vite emits under
 * `packages/desktop/out/main/`. A dump also lists Electron's own scripts and
 * every dependency the bundle requires at runtime (the `dependencies`
 * electron-vite leaves external) — none of it our source.
 */
export function isMainBundleUrl(url: string): boolean {
  return url.startsWith('file:') && url.includes('/packages/desktop/out/main/') && url.endsWith('.js');
}

/** How a main-bundle entry of a dump relates to the bundle on disk now. */
export type DumpEntryFreshness = 'fresh' | 'stale' | 'bundle-missing';

/**
 * Whether a dump written at `dumpWrittenAtMs` can be mapped onto the bundle
 * whose file was last written at `bundleBuiltAtMs` (`null`: no bundle there).
 * The bundle's path never changes between builds (`out/main/main.js`), so a
 * dump taken before the latest rebuild would map its offsets onto different
 * code without any error. Only possible locally: CI builds once, then runs,
 * and globalSetup empties the spool directory at the start of every run.
 */
export function dumpEntryFreshness(dumpWrittenAtMs: number, bundleBuiltAtMs: number | null): DumpEntryFreshness {
  if (bundleBuiltAtMs === null) return 'bundle-missing';
  return bundleBuiltAtMs > dumpWrittenAtMs ? 'stale' : 'fresh';
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isCoverageRange(value: unknown): value is Profiler.CoverageRange {
  return (
    isStringRecord(value) &&
    typeof value['startOffset'] === 'number' &&
    typeof value['endOffset'] === 'number' &&
    typeof value['count'] === 'number'
  );
}

function isFunctionCoverage(value: unknown): value is Profiler.FunctionCoverage {
  if (!isStringRecord(value)) return false;
  const ranges = value['ranges'];
  return (
    typeof value['functionName'] === 'string' &&
    typeof value['isBlockCoverage'] === 'boolean' &&
    isUnknownArray(ranges) &&
    ranges.every(isCoverageRange)
  );
}

function isScriptCoverage(value: unknown): value is Profiler.ScriptCoverage {
  if (!isStringRecord(value)) return false;
  const functions = value['functions'];
  return (
    typeof value['scriptId'] === 'string' &&
    typeof value['url'] === 'string' &&
    isUnknownArray(functions) &&
    functions.every(isFunctionCoverage)
  );
}

/**
 * The script coverages of one `NODE_V8_COVERAGE` dump (`{ result: [...] }`),
 * or `null` when `value` is not one. Every entry is checked, not just the ones
 * the collector keeps: a dump that is malformed anywhere was not written by
 * the Node the collector was written against, and the caller must fail
 * rather than guess which parts of it to trust.
 */
export function parseNodeCoverageDump(value: unknown): readonly Profiler.ScriptCoverage[] | null {
  if (!isStringRecord(value)) return null;
  const result = value['result'];
  if (!isUnknownArray(result) || !result.every(isScriptCoverage)) return null;
  return result;
}
