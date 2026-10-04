import { describe, it, expect } from 'vitest';
import { SecurityError } from '@costgoblin/core';
import { defaultDateRange, toDateRange } from '../tools/tool-helpers.js';

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

describe('defaultDateRange', () => {
  // The e2e FIXTURE_NOW; the window must follow the injected clock, not Date.
  const NOW_MS = Date.UTC(2026, 2, 2, 12);

  it('is the 30 days ending at the default lag before now', () => {
    expect(defaultDateRange(NOW_MS)).toEqual({ start: '2026-01-30', end: '2026-02-28' });
  });

  it('honours an explicit lag', () => {
    expect(defaultDateRange(NOW_MS, 0)).toEqual({ start: '2026-02-01', end: '2026-03-02' });
  });
});
