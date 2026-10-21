import { describe, it, expect } from 'vitest';
import {
  capToNewestDay,
  countPeriods,
  formatPeriodLabel,
  isPeriodGranularity,
  lastNPeriodsRange,
  periodEnd,
  periodStart,
  periodStartsInRange,
  previousPeriodRange,
  shiftPeriodStart,
  widenToPeriods,
} from '../query/periods.js';
import { asDateString } from '../types/branded.js';

const d = asDateString;

describe('period math', () => {
  it('recognises the period granularities', () => {
    expect(isPeriodGranularity('weekly')).toBe(true);
    expect(isPeriodGranularity('monthly')).toBe(true);
    expect(isPeriodGranularity('daily')).toBe(false);
    expect(isPeriodGranularity('hourly')).toBe(false);
  });

  it('starts ISO weeks on Monday and months on the 1st', () => {
    expect(periodStart(d('2026-10-21'), 'weekly')).toBe('2026-10-19');
    expect(periodEnd(d('2026-10-21'), 'weekly')).toBe('2026-10-25');
    expect(periodStart(d('2026-10-21'), 'monthly')).toBe('2026-10-01');
    expect(periodEnd(d('2028-02-10'), 'monthly')).toBe('2028-02-29');
  });

  it('keeps a Monday and a Sunday inside their own week', () => {
    expect(periodStart(d('2026-10-19'), 'weekly')).toBe('2026-10-19');
    expect(periodStart(d('2026-10-25'), 'weekly')).toBe('2026-10-19');
    expect(periodEnd(d('2026-10-19'), 'weekly')).toBe('2026-10-25');
    expect(periodEnd(d('2026-10-25'), 'weekly')).toBe('2026-10-25');
  });

  it('shifts a period start forward and back', () => {
    expect(shiftPeriodStart(d('2026-10-21'), 'weekly', 2)).toBe('2026-11-02');
    expect(shiftPeriodStart(d('2026-10-21'), 'weekly', -1)).toBe('2026-10-12');
    expect(shiftPeriodStart(d('2026-10-21'), 'monthly', 3)).toBe('2027-01-01');
    expect(shiftPeriodStart(d('2026-01-31'), 'monthly', -2)).toBe('2025-11-01');
    expect(shiftPeriodStart(d('2026-10-21'), 'monthly', 0)).toBe('2026-10-01');
  });

  it('labels with the ISO week-year', () => {
    expect(formatPeriodLabel(d('2025-12-29'), 'weekly')).toBe('W1 2026');
    expect(formatPeriodLabel(d('2027-01-01'), 'weekly')).toBe('W53 2026');
    expect(formatPeriodLabel(d('2026-10-19'), 'weekly')).toBe('W43 2026');
    expect(formatPeriodLabel(d('2026-10-01'), 'monthly')).toBe('Oct 2026');
  });

  it('widens to whole periods', () => {
    expect(widenToPeriods({ start: d('2026-03-15'), end: d('2026-10-21') }, 'monthly'))
      .toEqual({ start: '2026-03-01', end: '2026-10-31' });
    expect(widenToPeriods({ start: d('2026-03-01'), end: d('2026-10-31') }, 'weekly'))
      .toEqual({ start: '2026-02-23', end: '2026-11-01' });
  });

  it('counts the current period in Last N', () => {
    expect(lastNPeriodsRange(3, 'monthly', d('2026-10-19'))).toEqual({ start: '2026-08-01', end: '2026-10-31' });
    expect(lastNPeriodsRange(4, 'weekly', d('2026-10-19'))).toEqual({ start: '2026-09-28', end: '2026-10-25' });
  });

  it('compares to the same number of whole periods before', () => {
    expect(previousPeriodRange({ start: d('2026-03-01'), end: d('2026-10-31') }, 'monthly'))
      .toEqual({ start: '2025-07-01', end: '2026-02-28' });
    expect(previousPeriodRange({ start: d('2028-03-01'), end: d('2028-10-31') }, 'monthly'))
      .toEqual({ start: '2027-07-01', end: '2028-02-29' });
    expect(previousPeriodRange({ start: d('2026-10-05'), end: d('2026-10-25') }, 'weekly'))
      .toEqual({ start: '2026-09-14', end: '2026-10-04' });
  });

  it('lists period starts and counts them', () => {
    expect(periodStartsInRange({ start: d('2026-08-01'), end: d('2026-10-31') }, 'monthly'))
      .toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(periodStartsInRange({ start: d('2026-09-30'), end: d('2026-10-06') }, 'weekly'))
      .toEqual(['2026-09-28', '2026-10-05']);
    expect(countPeriods({ start: d('2026-09-28'), end: d('2026-10-25') }, 'weekly')).toBe(4);
    expect(countPeriods({ start: d('2025-11-15'), end: d('2026-02-02') }, 'monthly')).toBe(4);
  });

  it('caps the end at the newest day only when past it', () => {
    expect(capToNewestDay({ start: d('2026-10-01'), end: d('2026-10-31') }, d('2026-10-19'))).toEqual({ start: '2026-10-01', end: '2026-10-19' });
    expect(capToNewestDay({ start: d('2026-09-01'), end: d('2026-09-30') }, d('2026-10-19'))).toEqual({ start: '2026-09-01', end: '2026-09-30' });
  });

  it('throws on a date it cannot parse instead of looping forever', () => {
    const bad = d('not-a-date');
    expect(() => periodStart(bad, 'weekly')).toThrow(/invalid date/i);
    expect(() => periodStartsInRange({ start: bad, end: d('2026-10-01') }, 'monthly')).toThrow(/invalid date/i);
    expect(() => periodStartsInRange({ start: d('2026-10-01'), end: bad }, 'weekly')).toThrow(/invalid date/i);
  });
});
