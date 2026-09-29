import { describe, it, expect } from 'vitest';
import { SecurityError } from '@costgoblin/core';
import { toDateRange } from '../tools/tool-helpers.js';

describe('toDateRange', () => {
  it('accepts a valid YYYY-MM-DD range', () => {
    expect(toDateRange({ start: '2026-01-01', end: '2026-01-31' })).toEqual({
      start: '2026-01-01',
      end: '2026-01-31',
    });
  });

  it.each([
    ['a quote-breaking end', { start: '2026-01-01', end: "2026-01-31' OR '1'='1" }],
    ['a V8-parseable end', { start: '2026-01-01', end: "31 Jan 2026 (' OR 1=1 OR '" }],
    ['a trailing newline', { start: '2026-01-01', end: '2026-01-31\n' }],
    ['a hostile start', { start: "2026-01-01' --", end: '2026-01-31' }],
  ])('throws SecurityError for %s', (_label, range) => {
    expect(() => toDateRange(range)).toThrow(SecurityError);
  });
});
