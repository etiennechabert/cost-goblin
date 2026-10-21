import { describe, it, expect } from 'vitest';
import { asDateString } from '@costgoblin/core/browser';
import { pixelToIndex, bucketKeyToDate, computeBucketedHourRange, normalizeHourKey, periodBarsRange, resolveZoomDrag, shouldAutoSwitchToHourly, zoomGranularity } from '../lib/drag-select.js';

describe('pixelToIndex', () => {
  it('maps the left edge to index 0', () => {
    expect(pixelToIndex(0, 700, 7)).toBe(0);
  });

  it('maps the right edge to the last index', () => {
    expect(pixelToIndex(699, 700, 7)).toBe(6);
  });

  it('clamps x past the container to the last index', () => {
    expect(pixelToIndex(1000, 700, 7)).toBe(6);
  });

  it('clamps negative x to index 0', () => {
    expect(pixelToIndex(-50, 700, 7)).toBe(0);
  });

  it('returns 0 on degenerate inputs', () => {
    expect(pixelToIndex(50, 0, 7)).toBe(0);
    expect(pixelToIndex(50, 700, 0)).toBe(0);
  });

  it('splits the container into equal bins', () => {
    // 7 bars, 700px wide → each bar = 100px
    expect(pixelToIndex(0, 700, 7)).toBe(0);
    expect(pixelToIndex(99, 700, 7)).toBe(0);
    expect(pixelToIndex(100, 700, 7)).toBe(1);
    expect(pixelToIndex(350, 700, 7)).toBe(3);
  });
});

describe('bucketKeyToDate', () => {
  it('returns daily keys unchanged', () => {
    expect(bucketKeyToDate('2026-04-15')).toBe('2026-04-15');
  });

  it('trims hourly timestamps to the date part', () => {
    expect(bucketKeyToDate('2026-04-15 14:00:00')).toBe('2026-04-15');
    expect(bucketKeyToDate('2026-04-15 00:00:00')).toBe('2026-04-15');
  });

  it('returns short input unchanged', () => {
    expect(bucketKeyToDate('')).toBe('');
    expect(bucketKeyToDate('2026')).toBe('2026');
  });
});

describe('normalizeHourKey', () => {
  it('canonicalizes "YYYY-MM-DD HH:MM" to "YYYY-MM-DD HH:00:00"', () => {
    expect(normalizeHourKey('2026-04-30 14:00')).toBe('2026-04-30 14:00:00');
    expect(normalizeHourKey('2026-04-30 00:00')).toBe('2026-04-30 00:00:00');
  });

  it('preserves already-canonical hour keys', () => {
    expect(normalizeHourKey('2026-04-30 14:00:00')).toBe('2026-04-30 14:00:00');
  });

  it('returns null for date-only or malformed strings', () => {
    expect(normalizeHourKey('2026-04-30')).toBeNull();
    expect(normalizeHourKey('')).toBeNull();
    expect(normalizeHourKey('garbage')).toBeNull();
  });
});

describe('computeBucketedHourRange', () => {
  const hourBars = [
    { date: '2026-04-30 14:00' },
    { date: '2026-04-30 15:00' },
    { date: '2026-04-30 16:00' },
    { date: '2026-04-30 17:00' },
    { date: '2026-04-30 18:00' },
  ];

  it('returns the picked hour range when dragging in the middle', () => {
    const range = computeBucketedHourRange(hourBars, 0, 3, '2026-04-30 18:00');
    // start = first bar, end = (next bar's hour) - 1 = 17:00 - 1 wait actually
    // for indices 0..3 inclusive, next bar is index 4 (18:00); end = 18:00 - 1 = 17:00
    expect(range).toEqual({ startHour: '2026-04-30 14:00:00', endHour: '2026-04-30 17:00:00' });
  });

  it('drag inside a single hour bucket yields a single-hour range', () => {
    const range = computeBucketedHourRange(hourBars, 1, 1, '2026-04-30 18:00');
    expect(range).toEqual({ startHour: '2026-04-30 15:00:00', endHour: '2026-04-30 15:00:00' });
  });

  it('drag covering the last bar uses fallback for the end hour', () => {
    const range = computeBucketedHourRange(hourBars, 3, 4, '2026-04-30 18:00');
    expect(range).toEqual({ startHour: '2026-04-30 17:00:00', endHour: '2026-04-30 18:00:00' });
  });

  it('returns null for non-hourly bar keys', () => {
    const range = computeBucketedHourRange(
      [{ date: '2026-04-30' }, { date: '2026-05-01' }],
      0, 1, '2026-04-30 23:00',
    );
    expect(range).toBeNull();
  });
});

describe('shouldAutoSwitchToHourly', () => {
  it('switches when daily and the window is 7 days or fewer', () => {
    expect(shouldAutoSwitchToHourly('2026-04-01', '2026-04-01', 'daily')).toBe(true);
    expect(shouldAutoSwitchToHourly('2026-04-01', '2026-04-07', 'daily')).toBe(true);
  });

  it('does not switch when the window is wider than 7 days', () => {
    expect(shouldAutoSwitchToHourly('2026-04-01', '2026-04-08', 'daily')).toBe(false);
    expect(shouldAutoSwitchToHourly('2026-04-01', '2026-04-30', 'daily')).toBe(false);
  });

  it('never switches away from hourly', () => {
    expect(shouldAutoSwitchToHourly('2026-04-01', '2026-04-01', 'hourly')).toBe(false);
    expect(shouldAutoSwitchToHourly('2026-04-01', '2026-04-07', 'hourly')).toBe(false);
  });
});

describe('zoomGranularity', () => {
  it('drops a Monthly selection of two months or fewer to Daily, and keeps three', () => {
    expect(zoomGranularity({ start: '2026-08-01', end: '2026-08-31' }, 'monthly')).toBe('daily');
    expect(zoomGranularity({ start: '2026-08-01', end: '2026-09-30' }, 'monthly')).toBe('daily');
    expect(zoomGranularity({ start: '2026-08-01', end: '2026-10-31' }, 'monthly')).toBe('monthly');
  });

  it('drops a Weekly selection of three weeks or fewer to Daily, and keeps four', () => {
    expect(zoomGranularity({ start: '2026-10-05', end: '2026-10-11' }, 'weekly')).toBe('daily');
    expect(zoomGranularity({ start: '2026-10-05', end: '2026-10-25' }, 'weekly')).toBe('daily');
    expect(zoomGranularity({ start: '2026-10-05', end: '2026-11-01' }, 'weekly')).toBe('weekly');
  });

  it('zooms a Daily window of a week or less to Hourly, and keeps a longer one', () => {
    expect(zoomGranularity({ start: '2026-04-01', end: '2026-04-07' }, 'daily')).toBe('hourly');
    expect(zoomGranularity({ start: '2026-04-01', end: '2026-04-08' }, 'daily')).toBe('daily');
  });

  it('keeps Hourly', () => {
    expect(zoomGranularity({ start: '2026-04-01', end: '2026-04-01' }, 'hourly')).toBe('hourly');
  });
});

describe('periodBarsRange', () => {
  const months = [{ date: '2026-08-01' }, { date: '2026-09-01' }, { date: '2026-10-01' }];

  it('runs from the first bar\'s period start to the last bar\'s period end', () => {
    expect(periodBarsRange(months, 0, 1, 'monthly')).toEqual({ start: '2026-08-01', end: '2026-09-30' });
    expect(periodBarsRange(months, 2, 2, 'monthly')).toEqual({ start: '2026-10-01', end: '2026-10-31' });
  });

  it('spans ISO weeks Monday to Sunday', () => {
    const weeks = [{ date: '2026-10-05' }, { date: '2026-10-12' }, { date: '2026-10-19' }];
    expect(periodBarsRange(weeks, 0, 2, 'weekly')).toEqual({ start: '2026-10-05', end: '2026-10-25' });
  });

  it('is null when an index has no bar', () => {
    expect(periodBarsRange(months, 0, 3, 'monthly')).toBeNull();
    expect(periodBarsRange(months, -1, 1, 'monthly')).toBeNull();
  });
});

describe('resolveZoomDrag', () => {
  const newest = asDateString('2026-10-19');
  const range = (start: string, end: string) => ({ start: asDateString(start), end: asDateString(end) });

  it('drops a short period drag to Daily over its days', () => {
    expect(resolveZoomDrag(range('2026-05-01', '2026-06-30'), 'monthly', newest))
      .toEqual({ range: range('2026-05-01', '2026-06-30'), granularity: 'daily' });
  });

  it('caps a period drag that drops to Daily at the newest day', () => {
    expect(resolveZoomDrag(range('2026-09-01', '2026-10-31'), 'monthly', newest))
      .toEqual({ range: range('2026-09-01', '2026-10-19'), granularity: 'daily' });
  });

  it('ignores a period drag that starts after the newest day', () => {
    expect(resolveZoomDrag(range('2026-10-20', '2026-10-25'), 'weekly', newest)).toBeNull();
  });

  it('keeps a long period drag whole, past the newest day', () => {
    expect(resolveZoomDrag(range('2026-08-01', '2026-10-31'), 'monthly', newest))
      .toEqual({ range: range('2026-08-01', '2026-10-31'), granularity: 'monthly' });
  });

  it('leaves Daily and Hourly drags as dragged', () => {
    expect(resolveZoomDrag(range('2026-10-18', '2026-10-25'), 'daily', newest))
      .toEqual({ range: range('2026-10-18', '2026-10-25'), granularity: 'daily' });
    expect(resolveZoomDrag(range('2026-10-20', '2026-10-22'), 'daily', newest))
      .toEqual({ range: range('2026-10-20', '2026-10-22'), granularity: 'hourly' });
  });
});
