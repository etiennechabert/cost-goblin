import { describe, expect, it } from 'vitest';
import { computeBucketedHourRange, computeBucketedRange, formatBucketKey, pixelRangeToBars } from '../lib/drag-select.js';

// 7 bars across 700px: each bar is 100px wide, so "majority" means >50px.
describe('pixelRangeToBars', () => {
  it('returns null when there is nothing to map onto', () => {
    expect(pixelRangeToBars(10, 90, 700, 0)).toBeNull();
    expect(pixelRangeToBars(10, 90, 0, 7)).toBeNull();
  });

  it('includes only the bars the drag covers by more than half', () => {
    // Bars 1 and 4 are exactly half covered: they drop out.
    expect(pixelRangeToBars(150, 450, 700, 7)).toEqual({ startIdx: 2, endIdx: 3 });
  });

  it('keeps the boundary bars the user overshot into by more than half', () => {
    expect(pixelRangeToBars(40, 360, 700, 7)).toEqual({ startIdx: 0, endIdx: 3 });
  });

  it('falls back to the bar under the midpoint for a drag inside one bar', () => {
    expect(pixelRangeToBars(120, 140, 700, 7)).toEqual({ startIdx: 1, endIdx: 1 });
    // A tiny drag over the last bar's right half still selects it.
    expect(pixelRangeToBars(680, 690, 700, 7)).toEqual({ startIdx: 6, endIdx: 6 });
  });
});

describe('formatBucketKey', () => {
  it('formats a daily key as month and day', () => {
    expect(formatBucketKey('2026-05-01')).toBe('May 1');
  });

  it('keeps the hour of an hourly key, with or without seconds', () => {
    expect(formatBucketKey('2026-05-01 21:00')).toBe('May 1 21:00');
    expect(formatBucketKey('2026-05-01 21:00:00')).toBe('May 1 21:00');
  });

  it('shows only the date for a long key that is not "date hour"', () => {
    expect(formatBucketKey('2026-05-01T21:00')).toBe('May 1');
  });

  it('returns an empty key as is', () => {
    expect(formatBucketKey('')).toBe('');
  });

  it.each(['abcd-05-01', '2026', '2026-05'])('returns %s unchanged when it is not a date', (key) => {
    expect(formatBucketKey(key)).toBe(key);
  });
});

describe('computeBucketedRange', () => {
  const weekly = [{ date: '2026-04-01' }, { date: '2026-04-08' }, { date: '2026-04-15' }];

  it('ends the range the day before the next chunk starts', () => {
    expect(computeBucketedRange(weekly, 0, 1, '2026-04-21')).toEqual({ startDate: '2026-04-01', endDate: '2026-04-14' });
  });

  it('ends at the visible end when the last bar is included', () => {
    expect(computeBucketedRange(weekly, 1, 2, '2026-04-21')).toEqual({ startDate: '2026-04-08', endDate: '2026-04-21' });
  });

  it('returns null for an index outside the bars', () => {
    expect(computeBucketedRange(weekly, 3, 3, '2026-04-21')).toBeNull();
    expect(computeBucketedRange(weekly, 0, 5, '2026-04-21')).toBeNull();
  });

  it('never ends before it starts', () => {
    expect(computeBucketedRange(weekly, 2, 2, '2026-04-01')).toEqual({ startDate: '2026-04-15', endDate: '2026-04-15' });
    const repeated = [{ date: '2026-04-05' }, { date: '2026-04-05' }];
    expect(computeBucketedRange(repeated, 0, 0, '2026-04-30')).toEqual({ startDate: '2026-04-05', endDate: '2026-04-05' });
  });

  it('reads hourly bar keys as their day', () => {
    const hours = [{ date: '2026-04-30 14:00' }, { date: '2026-05-01 02:00' }];
    expect(computeBucketedRange(hours, 0, 0, '2026-05-01')).toEqual({ startDate: '2026-04-30', endDate: '2026-04-30' });
  });
});

describe('computeBucketedHourRange — edges', () => {
  const hours = [{ date: '2026-04-30 22:00' }, { date: '2026-05-01 00:00' }];

  it('ends an hour before the next bar, across midnight', () => {
    expect(computeBucketedHourRange(hours, 0, 0, '2026-05-01 03:00')).toEqual({ startHour: '2026-04-30 22:00:00', endHour: '2026-04-30 23:00:00' });
  });

  it('returns null when a bar is missing or the next bar is not hourly', () => {
    expect(computeBucketedHourRange(hours, 2, 2, '2026-05-01 03:00')).toBeNull();
    expect(computeBucketedHourRange([{ date: '2026-04-30 22:00' }, { date: '2026-05-01' }], 0, 0, '2026-05-01 03:00')).toBeNull();
  });

  it('falls back to the start hour when the visible end is not an hour', () => {
    expect(computeBucketedHourRange(hours, 1, 1, '2026-05-01')).toEqual({ startHour: '2026-05-01 00:00:00', endHour: '2026-05-01 00:00:00' });
  });

  it('never ends before it starts', () => {
    const repeated = [{ date: '2026-04-30 14:00' }, { date: '2026-04-30 14:00' }];
    expect(computeBucketedHourRange(repeated, 0, 0, '2026-04-30 20:00')).toEqual({ startHour: '2026-04-30 14:00:00', endHour: '2026-04-30 14:00:00' });
  });
});
