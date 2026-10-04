import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { clockPinnedTo, daysBefore, parseFixedNow, trailingWindow } from '../utils/clock.js';

const FIXTURE_NOW_MS = Date.UTC(2026, 2, 2, 12);

describe('parseFixedNow', () => {
  it('parses an ISO timestamp to epoch ms', () => {
    expect(parseFixedNow('2026-03-02T12:00:00Z')).toBe(FIXTURE_NOW_MS);
  });

  it('parses a date-only value as UTC midnight', () => {
    expect(parseFixedNow('2026-03-02')).toBe(Date.UTC(2026, 2, 2));
  });

  it('returns null when unset, empty or unparseable (every real launch)', () => {
    expect(parseFixedNow(undefined)).toBeNull();
    expect(parseFixedNow('')).toBeNull();
    expect(parseFixedNow('not a date')).toBeNull();
  });
});

describe('clockPinnedTo', () => {
  it('stays frozen at the pinned instant', () => {
    const now = clockPinnedTo(FIXTURE_NOW_MS);
    expect(now()).toBe(FIXTURE_NOW_MS);
    expect(now()).toBe(FIXTURE_NOW_MS);
  });

  it('reads the real clock when nothing is pinned', () => {
    const now = clockPinnedTo(null);
    const before = Date.now();
    const read = now();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
  });
});

describe('daysBefore', () => {
  it('returns the UTC calendar day N days before now', () => {
    expect(daysBefore(FIXTURE_NOW_MS, 0)).toBe('2026-03-02');
    expect(daysBefore(FIXTURE_NOW_MS, 2)).toBe('2026-02-28');
    expect(daysBefore(FIXTURE_NOW_MS, 30)).toBe('2026-01-31');
  });

  it('uses the UTC day, not the local one', () => {
    // 23:30 UTC is already the next day in UTC+1 zones; the result must not move.
    expect(daysBefore(Date.UTC(2026, 2, 2, 23, 30), 0)).toBe('2026-03-02');
  });
});

describe('trailingWindow', () => {
  it('spans windowDays inclusive days ending lagDays before now', () => {
    expect(trailingWindow(FIXTURE_NOW_MS, 2, 30)).toEqual({ start: '2026-01-30', end: '2026-02-28' });
  });

  it('a one-day window starts and ends on the same day', () => {
    expect(trailingWindow(FIXTURE_NOW_MS, 0, 1)).toEqual({ start: '2026-03-02', end: '2026-03-02' });
  });
});

describe('@costgoblin/core/clock', () => {
  it('stays a leaf module: the sandboxed preload bundles it', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'utils', 'clock.ts'), 'utf-8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(/^\s*export\b[^;]*\bfrom\s/m);
    expect(source).not.toMatch(/\bimport\(/);
  });
});
