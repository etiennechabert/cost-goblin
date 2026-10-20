import { describe, expect, it } from 'vitest';
import { asDateString, asHourString } from '../types/branded.js';
import { DEFAULT_LAG_DAYS } from '../types/cost-scope.js';
import type { DateRange } from '../types/query.js';
import { capDateRange, capToFreshnessLag, freshnessCutoff } from '../query/freshness.js';

const NOW_MS = Date.UTC(2026, 9, 20, 15);
const CUTOFF = asDateString('2026-10-13');

function days(start: string, end: string): DateRange {
  return { start: asDateString(start), end: asDateString(end) };
}

describe('freshnessCutoff', () => {
  it('is the UTC day lagDays before now', () => {
    expect(freshnessCutoff(NOW_MS, 7)).toBe('2026-10-13');
    expect(freshnessCutoff(NOW_MS, 0)).toBe('2026-10-20');
  });

  it('falls back to the default lag when the cost scope leaves it unset', () => {
    expect(freshnessCutoff(NOW_MS, undefined)).toBe(freshnessCutoff(NOW_MS, DEFAULT_LAG_DAYS));
  });
});

describe('capDateRange', () => {
  it('returns a range ending on or before the cutoff as is', () => {
    const range = days('2026-09-14', '2026-10-13');
    expect(capDateRange(range, CUTOFF)).toBe(range);
  });

  it('moves the end of a range past the cutoff back to it', () => {
    expect(capDateRange(days('2026-09-18', '2026-10-18'), CUTOFF)).toEqual(days('2026-09-18', '2026-10-13'));
  });

  it('keeps a one-day range on the cutoff itself', () => {
    expect(capDateRange(days('2026-10-13', '2026-10-31'), CUTOFF)).toEqual(days('2026-10-13', '2026-10-13'));
  });

  it('is null for a range that starts after the cutoff', () => {
    expect(capDateRange(days('2026-10-14', '2026-10-20'), CUTOFF)).toBeNull();
  });

  it('caps the hour bounds at the last hour of the cutoff day', () => {
    const range: DateRange = {
      ...days('2026-10-12', '2026-10-15'),
      startHour: asHourString('2026-10-12 06:00:00'),
      endHour: asHourString('2026-10-15 18:00:00'),
    };
    expect(capDateRange(range, CUTOFF)).toEqual({
      ...days('2026-10-12', '2026-10-13'),
      startHour: asHourString('2026-10-12 06:00:00'),
      endHour: asHourString('2026-10-13 23:00:00'),
    });
  });

  it('keeps an end hour already on or before the cutoff', () => {
    const range: DateRange = {
      ...days('2026-10-12', '2026-10-14'),
      startHour: asHourString('2026-10-12 06:00:00'),
      endHour: asHourString('2026-10-13 04:00:00'),
    };
    expect(capDateRange(range, CUTOFF)).toEqual({ ...range, end: CUTOFF });
  });

  it('is null when the start hour falls after the cutoff', () => {
    const range: DateRange = {
      ...days('2026-10-13', '2026-10-15'),
      startHour: asHourString('2026-10-14 06:00:00'),
      endHour: asHourString('2026-10-15 18:00:00'),
    };
    expect(capDateRange(range, CUTOFF)).toBeNull();
  });
});

describe('capToFreshnessLag', () => {
  it('caps at lagDays before now', () => {
    expect(capToFreshnessLag(days('2026-09-18', '2026-10-18'), NOW_MS, 7)).toEqual(days('2026-09-18', '2026-10-13'));
    expect(capToFreshnessLag(days('2026-10-19', '2026-10-20'), NOW_MS, 2)).toBeNull();
  });
});
