import { describe, it, expect } from 'vitest';
import { pixelToIndex, bucketKeyToDate, computeBucketedHourRange, normalizeHourKey, shouldAutoSwitchToHourly } from '../lib/drag-select.js';

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
