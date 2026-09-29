/** Wall-clock-bounded execution of a built-in dimension's `nameStripPatterns`.
 *
 *  NODE-ONLY: this module needs `node:vm`. It is exported from the package's
 *  Node entry (`src/index.ts`) by name and must never be re-exported from
 *  `normalize/index.ts`, which the browser entry re-exports
 *  (`__tests__/browser-entry.test.ts` enforces this).
 *
 *  Why: the patterns come from config a colleague can share (YAML, bundle,
 *  beacon, peer pull) and the names they run over can come from a peer's
 *  org-accounts.json, so both halves are untrusted. JavaScript regexes
 *  backtrack, and a pattern like `((.+)+)+z` takes ~23 s on a 20-character
 *  name and never finishes on a longer one — synchronously, on the Electron
 *  main thread. A regex cannot be interrupted from the same realm, and
 *  "reject nested quantifiers" is bypassed by lookahead/backreference shapes
 *  that force V8's backtracking engine, so each pattern runs inside a
 *  `node:vm` context with a `timeout`, which V8 honours mid-match.
 *
 *  Isolation model: ONE fixed script is compiled once at module load. A
 *  pattern and the names reach it only as data (context globals), never as
 *  source text, so nothing user-controlled is ever evaluated as code. */

import { performance } from 'node:perf_hooks';
import { Script, createContext } from 'node:vm';

export interface StripBudget {
  /** Upper bound for a single pattern's run over every name. */
  readonly perPatternMs: number;
  /** Upper bound for the whole call; later patterns are skipped once spent. */
  readonly totalMs: number;
}

export interface StripNamesResult {
  /** Same length and order as the input names. */
  readonly names: string[];
  /** Indexes of patterns that did not compile, or threw while running (e.g. a
   *  stack overflow on a huge name). Their effect is discarded. */
  readonly invalidPatterns: number[];
  /** Indexes of patterns that exceeded their time budget (now, or on an
   *  earlier call at a budget at least this large). Their effect is discarded. */
  readonly slowPatterns: number[];
  /** Indexes of patterns never run because the call's total budget ran out. */
  readonly skippedPatterns: number[];
}

/** Account-map build: runs once per cache lifetime, off the query hot path. */
export const ACCOUNT_MAP_STRIP_BUDGET: StripBudget = { perPatternMs: 500, totalMs: 1000 };
/** Editor preview: re-run as the user edits, so it gets a tighter bound. */
export const PREVIEW_STRIP_BUDGET: StripBudget = { perPatternMs: 150, totalMs: 300 };

// The only code the inner realm ever runs. `pattern` and `names` are context
// globals set per run; neither is ever interpolated into this source.
const STRIP_SOURCE = `'use strict';
(function stripAll() {
  const re = new RegExp(pattern, 'g');
  const out = [];
  for (let i = 0; i < names.length; i++) out.push(names[i].replaceAll(re, ''));
  return out;
})();`;

interface StripSandbox {
  names: readonly string[];
  pattern: string;
}

const STRIP_SCRIPT = new Script(STRIP_SOURCE, { filename: 'costgoblin-strip-patterns.vm.js' });
const sandbox: StripSandbox = { names: [], pattern: '' };
// No eval/new Function/wasm in the inner realm: defence in depth, since the
// fixed script needs none of them.
const context = createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });

const SLOW_MEMO_LIMIT = 128;
/** pattern → the largest FULL per-pattern budget (ms) it has been seen to
 *  exceed. Lets a repeated hostile pattern be skipped without spending its
 *  budget again (the account map is rebuilt on every dimensions/org change,
 *  the preview on every edit). Bounded; the oldest entry is evicted first. */
const slowMemo = new Map<string, number>();

function isKnownSlow(pattern: string, perPatternMs: number): boolean {
  const recorded = slowMemo.get(pattern);
  return recorded !== undefined && recorded >= perPatternMs;
}

function rememberSlow(pattern: string, perPatternMs: number): void {
  const recorded = slowMemo.get(pattern);
  if (recorded !== undefined && recorded >= perPatternMs) return;
  slowMemo.delete(pattern);
  slowMemo.set(pattern, perPatternMs);
  if (slowMemo.size > SLOW_MEMO_LIMIT) {
    const oldest = slowMemo.keys().next();
    if (oldest.done !== true) slowMemo.delete(oldest.value);
  }
}

/** Compiles in THIS realm, where a SyntaxError is cheap and unambiguous. */
function compiles(pattern: string): boolean {
  try {
    return new RegExp(pattern, 'g').global;
  } catch {
    return false;
  }
}

function isTimeoutError(err: unknown): boolean {
  // Errors from the inner realm fail `instanceof Error` here, so identify the
  // timeout by its Node error code.
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

function isStringArrayOfLength(value: unknown, length: number): value is readonly string[] {
  return Array.isArray(value) && value.length === length && value.every((v: unknown) => typeof v === 'string');
}

type RunOutcome =
  | { readonly kind: 'ok'; readonly names: string[] }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'error' };

function runPattern(names: readonly string[], pattern: string, timeoutMs: number): RunOutcome {
  sandbox.names = names;
  sandbox.pattern = pattern;
  try {
    const out: unknown = STRIP_SCRIPT.runInContext(context, { timeout: timeoutMs });
    return isStringArrayOfLength(out, names.length) ? { kind: 'ok', names: [...out] } : { kind: 'error' };
  } catch (err: unknown) {
    return isTimeoutError(err) ? { kind: 'timeout' } : { kind: 'error' };
  } finally {
    // Don't pin the (possibly large) name list to the long-lived context.
    sandbox.names = [];
    sandbox.pattern = '';
  }
}

/** Apply `patterns` in order (each with empty-string replacement), then
 *  collapse whitespace runs and trim — byte-identical to the previous
 *  unbounded implementation for every pattern that finishes in time.
 *  `undefined` or `[]` returns the names untouched (no collapse); `''`
 *  patterns are no-ops that still trigger the collapse.
 *
 *  Never throws for a bad pattern and blocks for at most about
 *  `budget.totalMs`: a pattern that fails to compile, throws, or runs out of
 *  time is reported by index and its effect discarded, so the names keep the
 *  previous patterns' result. Reports carry indexes only — callers must not
 *  log pattern text or names. */
export function stripNamesBounded(
  names: readonly string[],
  patterns: readonly string[] | undefined,
  budget: StripBudget,
): StripNamesResult {
  const invalidPatterns: number[] = [];
  const slowPatterns: number[] = [];
  const skippedPatterns: number[] = [];
  if (patterns === undefined || patterns.length === 0) {
    return { names: [...names], invalidPatterns, slowPatterns, skippedPatterns };
  }

  const perPatternMs = Math.floor(budget.perPatternMs);
  const deadline = performance.now() + budget.totalMs;
  let current: readonly string[] = names;
  let exhausted = false;

  for (const [i, pattern] of patterns.entries()) {
    if (pattern.length === 0) continue;
    if (!compiles(pattern)) {
      invalidPatterns.push(i);
      continue;
    }
    if (isKnownSlow(pattern, perPatternMs)) {
      slowPatterns.push(i);
      continue;
    }
    // vm rejects a timeout below 1 ms (ERR_OUT_OF_RANGE), and a fraction of a
    // millisecond left is no budget anyway: this and every later pattern that
    // would have to run are skipped.
    const timeoutMs = exhausted ? 0 : Math.min(perPatternMs, Math.floor(deadline - performance.now()));
    if (timeoutMs < 1) {
      exhausted = true;
      skippedPatterns.push(i);
      continue;
    }
    const outcome = runPattern(current, pattern, timeoutMs);
    switch (outcome.kind) {
      case 'ok':
        current = outcome.names;
        break;
      case 'timeout':
        slowPatterns.push(i);
        // Only a full-budget run says something about the pattern itself; a
        // run cut short by the call's deadline does not.
        if (timeoutMs === perPatternMs) rememberSlow(pattern, perPatternMs);
        break;
      case 'error':
        invalidPatterns.push(i);
        break;
    }
  }

  return {
    names: current.map(n => n.replaceAll(/\s+/g, ' ').trim()),
    invalidPatterns,
    slowPatterns,
    skippedPatterns,
  };
}
