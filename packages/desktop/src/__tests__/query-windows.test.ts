import { describe, expect, it } from 'vitest';
import { costScopePreviewWindow, resolveExplorerDateRange, tagDiscoverySince } from '../main/handlers/query-windows.js';

// The e2e FIXTURE_NOW: the day after the synthetic fixture window (Jan–Feb 2026).
const FIXTURE_NOW_MS = Date.UTC(2026, 2, 2, 12);

describe('costScopePreviewWindow', () => {
  it('is the 30 days ending lagDays before the injected now', () => {
    expect(costScopePreviewWindow(FIXTURE_NOW_MS, 2)).toEqual({ windowDays: 30, startDate: '2026-01-30', endDate: '2026-02-28' });
  });

  it('follows the lag', () => {
    expect(costScopePreviewWindow(FIXTURE_NOW_MS, 0)).toEqual({ windowDays: 30, startDate: '2026-02-01', endDate: '2026-03-02' });
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
});
