import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_MAP_STRIP_BUDGET,
  PREVIEW_STRIP_BUDGET,
  stripNamesBounded,
} from '../normalize/strip-bounded.js';

/** The unbounded implementation this module replaces, copied verbatim as the
 *  parity oracle: for every benign pattern set, the bounded executor must
 *  produce byte-identical names. */
function oracleApplyStripPatterns(value: string, patterns: readonly string[] | undefined): string {
  if (patterns === undefined || patterns.length === 0) return value;
  let result = value;
  for (const p of patterns) {
    if (p.length === 0) continue;
    try {
      result = result.replaceAll(new RegExp(p, 'g'), '');
    } catch { /* invalid regex — skip silently so a typo doesn't blow up resolution */ }
  }
  return result.replaceAll(/\s+/g, ' ').trim();
}

const SAMPLE_NAMES: readonly string[] = [
  'acme-payments-production',
  'acme-payments-staging',
  'Acme Search   sandbox',
  'DiBa Cards Core Banking',
  'DiBa Cards  ',
  '  spaced   out\tname  production',
  'aaa',
  '',
  'no-match-here',
];

const BENIGN_PATTERN_SETS: readonly (readonly string[] | undefined)[] = [
  undefined,
  [],
  ['^acme-'],
  [String.raw`\s+(production|staging|sandbox)$`],
  ['^DiBa Cards '],
  [''],
  ['(unclosed', 'foo'],
  ['a', 'a'],
  ['^acme-', String.raw`-(production|staging)$`, '^DiBa Cards '],
];

const BIG_BUDGET = { perPatternMs: 1000, totalMs: 5000 };
const CATASTROPHIC_NAME = 'acme-payments-production-eu-west-1';

describe('stripNamesBounded — parity with the unbounded implementation', () => {
  it.each(BENIGN_PATTERN_SETS.map((p): [string, readonly string[] | undefined] => [p === undefined ? 'undefined' : JSON.stringify(p), p]))(
    'matches the oracle for %s',
    (_label, patterns) => {
      const result = stripNamesBounded(SAMPLE_NAMES, patterns, BIG_BUDGET);
      expect(result.names).toEqual(SAMPLE_NAMES.map(n => oracleApplyStripPatterns(n, patterns)));
    },
  );

  it('leaves names untouched (no whitespace collapse) for undefined and []', () => {
    for (const patterns of [undefined, []]) {
      const result = stripNamesBounded(['  a   b  '], patterns, BIG_BUDGET);
      expect(result).toEqual({ names: ['  a   b  '], invalidPatterns: [], slowPatterns: [], skippedPatterns: [] });
    }
  });

  it('collapses whitespace for [\'\'] without reporting the empty pattern', () => {
    const result = stripNamesBounded(['  a   b  '], [''], BIG_BUDGET);
    expect(result).toEqual({ names: ['a b'], invalidPatterns: [], slowPatterns: [], skippedPatterns: [] });
  });

  it('reports an uncompilable pattern as invalid and still applies the next one', () => {
    const result = stripNamesBounded(['foo-bar'], ['(unclosed', 'foo'], BIG_BUDGET);
    expect(result.names).toEqual(['-bar']);
    expect(result.invalidPatterns).toEqual([0]);
    expect(result.slowPatterns).toEqual([]);
    expect(result.skippedPatterns).toEqual([]);
  });

  it('applies repeated patterns in order', () => {
    expect(stripNamesBounded(['aaa'], ['a', 'a'], BIG_BUDGET).names).toEqual(['']);
  });

  it('does not mutate its input', () => {
    const names = ['acme-x'];
    stripNamesBounded(names, ['^acme-'], BIG_BUDGET);
    expect(names).toEqual(['acme-x']);
  });
});

describe('stripNamesBounded — wall-clock bound', () => {
  it.each([
    ['nested quantifier', '((.+)+)+z'],
    ['lookahead (V8 fallback)', '((.+)+)+(?=z)'],
    ['backreference alternation (V8 fallback)', String.raw`((.+)+)+z|(q)\3`],
  ])('reports a catastrophic %s pattern as slow within budget and applies the next pattern', (_label, pattern) => {
    const started = performance.now();
    const result = stripNamesBounded([CATASTROPHIC_NAME], [pattern, '-eu-west-1$'], { perPatternMs: 100, totalMs: 1000 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(result.slowPatterns).toEqual([0]);
    expect(result.invalidPatterns).toEqual([]);
    expect(result.skippedPatterns).toEqual([]);
    expect(result.names).toEqual(['acme-payments-production']);
  });

  it('bounds 16 distinct hostile patterns by the total budget and skips the rest', () => {
    // Distinct per test: the slow-pattern memo is module-level.
    const patterns = Array.from({ length: 16 }, (_, i) => `((.+)+)+z${'q'.repeat(i + 1)}`);
    const started = performance.now();
    const result = stripNamesBounded([CATASTROPHIC_NAME], patterns, { perPatternMs: 200, totalMs: 1000 });
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1500);
    expect(result.skippedPatterns.length).toBeGreaterThan(0);
    expect(result.slowPatterns.length + result.skippedPatterns.length).toBe(16);
    expect(result.invalidPatterns).toEqual([]);
    // Every index is reported exactly once, and skipping is a suffix.
    const firstSkipped = Math.min(...result.skippedPatterns);
    expect(result.slowPatterns.every(i => i < firstSkipped)).toBe(true);
    expect(result.names).toEqual([CATASTROPHIC_NAME]);
  });

  it('skips a pattern it already saw exceed a full budget, and still reports it slow', () => {
    const pattern = '((.+)+)+k';
    stripNamesBounded([CATASTROPHIC_NAME], [pattern], { perPatternMs: 100, totalMs: 1000 });
    const started = performance.now();
    const result = stripNamesBounded([CATASTROPHIC_NAME], [pattern], { perPatternMs: 100, totalMs: 1000 });
    expect(performance.now() - started).toBeLessThan(50);
    expect(result.slowPatterns).toEqual([0]);
  });

  it('re-evaluates a known-slow pattern when given a larger per-pattern budget', () => {
    const pattern = '((.+)+)+x';
    stripNamesBounded([CATASTROPHIC_NAME], [pattern], { perPatternMs: 40, totalMs: 1000 });
    const started = performance.now();
    const result = stripNamesBounded([CATASTROPHIC_NAME], [pattern], { perPatternMs: 120, totalMs: 1000 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(result.slowPatterns).toEqual([0]);
  });

  it('does not remember a pattern that only ran out of a truncated budget', () => {
    const pattern = '((.+)+)+v';
    // totalMs < perPatternMs: the run is cut short by the call's deadline, so
    // it says nothing about the pattern's cost at the full per-pattern budget.
    stripNamesBounded([CATASTROPHIC_NAME], [pattern], { perPatternMs: 500, totalMs: 60 });
    const started = performance.now();
    stripNamesBounded([CATASTROPHIC_NAME], [pattern], { perPatternMs: 60, totalMs: 1000 });
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
  });

  it('skips every pattern when the call has no budget at all', () => {
    const result = stripNamesBounded(['acme-x'], ['^acme-', '', 'x'], { perPatternMs: 100, totalMs: 0 });
    expect(result.skippedPatterns).toEqual([0, 2]);
    expect(result.names).toEqual(['acme-x']);
  });

  it('reports a runtime regex failure on a huge name as invalid instead of throwing', () => {
    const huge = 'ab'.repeat(5_000_000);
    let result: ReturnType<typeof stripNamesBounded> | undefined;
    expect(() => { result = stripNamesBounded([huge, 'abc'], ['(?:a|b)*c', 'bc$'], ACCOUNT_MAP_STRIP_BUDGET); }).not.toThrow();
    expect(result?.invalidPatterns).toEqual([0]);
    expect(result?.names[1]).toBe('a');
  });

  it('strips 5,000 names with 5 benign patterns quickly', () => {
    const names = Array.from({ length: 5000 }, (_, i) => `acme-team-${String(i)} production`);
    const patterns = ['^acme-', String.raw`\s+(production|staging|sandbox)$`, '^DiBa Cards ', '-eu-west-1$', String.raw`\(legacy\)`];
    const started = performance.now();
    const result = stripNamesBounded(names, patterns, PREVIEW_STRIP_BUDGET);
    expect(performance.now() - started).toBeLessThan(200);
    expect(result.names[42]).toBe('team-42');
    expect(result.slowPatterns).toEqual([]);
    expect(result.skippedPatterns).toEqual([]);
  });

  it('exposes the documented budgets', () => {
    expect(ACCOUNT_MAP_STRIP_BUDGET).toEqual({ perPatternMs: 500, totalMs: 1000 });
    expect(PREVIEW_STRIP_BUDGET).toEqual({ perPatternMs: 150, totalMs: 300 });
  });
});
