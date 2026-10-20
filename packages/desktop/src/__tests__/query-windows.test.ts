import { describe, expect, it } from 'vitest';
import { asDateString } from '@costgoblin/core';
import { capPreviewWindow, capResolvedRange, costScopePreviewWindow, resolveExplorerDateRange, tagDiscoverySince } from '../main/handlers/query-windows.js';

// The e2e FIXTURE_NOW: the day after the synthetic fixture window (Jan–Feb 2026).
const FIXTURE_NOW_MS = Date.UTC(2026, 2, 2, 12);

describe('costScopePreviewWindow', () => {
  it('uses the period picked on the preview, whatever the clock and lag', () => {
    expect(costScopePreviewWindow({ start: '2026-02-21', end: '2026-02-28' }, FIXTURE_NOW_MS, 2))
      .toEqual({ windowDays: 8, startDate: '2026-02-21', endDate: '2026-02-28' });
    expect(costScopePreviewWindow({ start: '2025-01-01', end: '2025-12-31' }, FIXTURE_NOW_MS, 0))
      .toEqual({ windowDays: 365, startDate: '2025-01-01', endDate: '2025-12-31' });
  });

  it('falls back to the 30 days ending lagDays before the injected now', () => {
    expect(costScopePreviewWindow(undefined, FIXTURE_NOW_MS, 2)).toEqual({ windowDays: 30, startDate: '2026-01-30', endDate: '2026-02-28' });
  });

  it('follows the lag', () => {
    expect(costScopePreviewWindow(undefined, FIXTURE_NOW_MS, 0)).toEqual({ windowDays: 30, startDate: '2026-02-01', endDate: '2026-03-02' });
  });

  it('falls back on a malformed or inverted period, so nothing unvalidated reaches the SQL', () => {
    const fallback = { windowDays: 30, startDate: '2026-01-30', endDate: '2026-02-28' };
    for (const bad of [
      null,
      'last-30-days',
      { start: '2026-02-01' },
      { start: "2026-02-01' OR 1=1 --", end: '2026-02-28' },
      { start: '2026-13-01', end: '2026-12-31' },
      { start: 20260201, end: 20260228 },
      { start: '2026-02-28', end: '2026-02-01' },
    ]) {
      expect(costScopePreviewWindow(bad, FIXTURE_NOW_MS, 2)).toEqual(fallback);
    }
  });
});

describe('tagDiscoverySince', () => {
  it('samples from 30 days before the injected now', () => {
    expect(tagDiscoverySince(FIXTURE_NOW_MS)).toBe('2026-01-31');
  });
});

describe('resolveExplorerDateRange', () => {
  it('keeps a valid explicit range and ignores the clock', () => {
    expect(resolveExplorerDateRange({ start: '2025-01-01', end: '2025-01-10' }, FIXTURE_NOW_MS))
      .toEqual({ startStr: '2025-01-01', endStr: '2025-01-10', windowDays: 10 });
  });

  it('keeps valid hour bounds on an explicit range', () => {
    expect(resolveExplorerDateRange({ start: '2026-02-01', end: '2026-02-01', startHour: '2026-02-01 03:00:00', endHour: '2026-02-01 05:00:00' }, FIXTURE_NOW_MS))
      .toEqual({ startStr: '2026-02-01', endStr: '2026-02-01', windowDays: 1, startHour: '2026-02-01 03:00:00', endHour: '2026-02-01 05:00:00' });
  });

  it('drops malformed hour bounds, keeping the day range', () => {
    expect(resolveExplorerDateRange({ start: '2026-02-01', end: '2026-02-02', startHour: "x'; DROP", endHour: '2026-02-02 05:00:00' }, FIXTURE_NOW_MS))
      .toEqual({ startStr: '2026-02-01', endStr: '2026-02-02', windowDays: 2 });
  });

  it('falls back to the 30 days ending at the default lag before the injected now', () => {
    const fallback = { startStr: '2026-01-30', endStr: '2026-02-28', windowDays: 30 };
    expect(resolveExplorerDateRange(undefined, FIXTURE_NOW_MS)).toEqual(fallback);
    expect(resolveExplorerDateRange({ start: 'nope', end: '2026-01-01' }, FIXTURE_NOW_MS)).toEqual(fallback);
    // Inverted range falls back too.
    expect(resolveExplorerDateRange({ start: '2026-02-10', end: '2026-02-01' }, FIXTURE_NOW_MS)).toEqual(fallback);
  });

  it('ends the fallback window at the cost scope lag', () => {
    expect(resolveExplorerDateRange(undefined, FIXTURE_NOW_MS, 7)).toEqual({ startStr: '2026-01-25', endStr: '2026-02-23', windowDays: 30 });
  });
});

describe('capResolvedRange', () => {
  const CUTOFF = asDateString('2026-02-22');

  it('returns a range ending on or before the cutoff as is', () => {
    const range = { startStr: '2026-02-01', endStr: '2026-02-22', windowDays: 22 };
    expect(capResolvedRange(range, CUTOFF)).toBe(range);
  });

  it('moves the end back to the cutoff and recounts the days', () => {
    expect(capResolvedRange({ startStr: '2026-02-01', endStr: '2026-02-28', windowDays: 28 }, CUTOFF))
      .toEqual({ startStr: '2026-02-01', endStr: '2026-02-22', windowDays: 22 });
  });

  it('caps the hour bounds with the day', () => {
    expect(capResolvedRange({ startStr: '2026-02-21', endStr: '2026-02-24', windowDays: 4, startHour: '2026-02-21 03:00:00', endHour: '2026-02-24 05:00:00' }, CUTOFF))
      .toEqual({ startStr: '2026-02-21', endStr: '2026-02-22', windowDays: 2, startHour: '2026-02-21 03:00:00', endHour: '2026-02-22 23:00:00' });
  });

  it('is null for a range after the cutoff', () => {
    expect(capResolvedRange({ startStr: '2026-02-23', endStr: '2026-02-28', windowDays: 6 }, CUTOFF)).toBeNull();
  });
});

describe('capPreviewWindow', () => {
  it('stops the window at the cutoff, null when it lies entirely after it', () => {
    const cutoff = asDateString('2026-02-22');
    expect(capPreviewWindow({ windowDays: 28, startDate: '2026-02-01', endDate: '2026-02-28' }, cutoff))
      .toEqual({ windowDays: 22, startDate: '2026-02-01', endDate: '2026-02-22' });
    expect(capPreviewWindow({ windowDays: 4, startDate: '2026-02-25', endDate: '2026-02-28' }, cutoff)).toBeNull();
  });
});
