import { describe, it, expect } from 'vitest';
import { stripNamesBounded } from '../normalize/strip-bounded.js';

// The slow-pattern memo is module state: this file gets its own copy (vitest
// isolates test files), and the tests below run in order against it.

/** No "z#" in it, so every `hostile()` pattern backtracks catastrophically. */
const HOSTILE_NAME = 'acme-payments-production-eu-west-1';
/** Catastrophic on HOSTILE_NAME, instant on a short name that ends in `z#<tag>`. */
const hostile = (tag: string): string => `((.+)+)+z#${tag}`;
/** One entry more than this and the oldest remembered pattern is dropped. */
const SLOW_MEMO_LIMIT = 128;

const FULL_BUDGET = { perPatternMs: 100, totalMs: 10_000 };
const FILLER_BUDGET = { perPatternMs: 1, totalMs: 10_000 };

/** True when `pattern` is skipped as known-slow at FULL_BUDGET: on a name it
 *  matches instantly, only the memo can still report it slow. */
function rememberedAsSlow(pattern: string, tag: string): boolean {
  const result = stripNamesBounded([`x z#${tag}`], [pattern], FULL_BUDGET);
  if (result.slowPatterns.length === 0) {
    // It ran: the benign name was stripped, and nothing else was reported.
    expect(result).toEqual({ names: [''], invalidPatterns: [], slowPatterns: [], skippedPatterns: [] });
    return false;
  }
  expect(result).toEqual({ names: [`x z#${tag}`], invalidPatterns: [], slowPatterns: [0], skippedPatterns: [] });
  return true;
}

describe('stripNamesBounded — bounded slow-pattern memo', () => {
  it('evicts the oldest remembered pattern first once more than 128 are known', () => {
    const target = hostile('t');
    const control = hostile('c');
    expect(stripNamesBounded([HOSTILE_NAME], [target, control], FULL_BUDGET).slowPatterns).toEqual([0, 1]);
    expect(rememberedAsSlow(target, 't')).toBe(true);
    expect(rememberedAsSlow(control, 'c')).toBe(true);

    // Fill the memo up to its limit: nothing is evicted yet.
    const fillers = Array.from({ length: SLOW_MEMO_LIMIT - 2 }, (_, i) => hostile(`f${String(i)}`));
    expect(stripNamesBounded([HOSTILE_NAME], fillers, FILLER_BUDGET).slowPatterns).toHaveLength(fillers.length);
    expect(rememberedAsSlow(target, 't')).toBe(true);

    // One more slow pattern pushes out the oldest entry, and only that one.
    expect(stripNamesBounded([HOSTILE_NAME], [hostile('extra-1')], FILLER_BUDGET).slowPatterns).toEqual([0]);
    expect(rememberedAsSlow(target, 't')).toBe(false);
    expect(rememberedAsSlow(control, 'c')).toBe(true);

    // The next one evicts what is now the oldest.
    expect(stripNamesBounded([HOSTILE_NAME], [hostile('extra-2')], FILLER_BUDGET).slowPatterns).toEqual([0]);
    expect(rememberedAsSlow(control, 'c')).toBe(false);
  });
});

describe('stripNamesBounded — sandbox output check', () => {
  it('discards a run whose result is not one string per name', () => {
    // Defence in depth: the inner realm's result is re-checked here. A
    // name-like object that answers the sandbox's replaceAll with a number
    // makes the run malformed; this realm's whitespace pass (an outer-realm
    // RegExp) still gets text back.
    const nameLike = {
      replaceAll(search: unknown): unknown {
        return search instanceof RegExp ? '  kept  ' : 42;
      },
    };
    const names: string[] = ['acme-x'];
    Reflect.set(names, 1, nameLike);

    const result = stripNamesBounded(names, ['^acme-'], FULL_BUDGET);
    // The whole run is discarded: even the real name keeps its prefix.
    expect(result).toEqual({ names: ['acme-x', 'kept'], invalidPatterns: [0], slowPatterns: [], skippedPatterns: [] });
  });
});
