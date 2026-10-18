import { describe, it, expect } from 'vitest';
import type { CostResult, DailyCostsResult, DateRange } from '@costgoblin/core/browser';
import { asDateString, asDollars, asEntityRef, asHourString } from '@costgoblin/core/browser';
import { hasSufficientCoverage, hasSufficientDailyCoverage, previousDayLookup } from '../widgets/widget.js';

// 28 days: 80% of it is 22.4.
const ASKED: DateRange = { start: asDateString('2026-01-04'), end: asDateString('2026-01-31') };

function result(fields: { readonly dateRange?: DateRange; readonly coveredDays?: number; readonly cost?: number } = {}): CostResult {
  const cost = fields.cost ?? 100;
  return {
    rows: cost === 0 ? [] : [{ entity: asEntityRef('prod'), totalCost: asDollars(cost), serviceCosts: {} }],
    totalCost: asDollars(cost),
    topServices: [],
    dateRange: fields.dateRange ?? ASKED,
    ...(fields.coveredDays === undefined ? {} : { coveredDays: fields.coveredDays }),
  };
}

describe('hasSufficientCoverage', () => {
  it('goes by the covered days the main process reports, not the range it echoes', () => {
    expect(hasSufficientCoverage(result({ coveredDays: 0 }), ASKED)).toBe(false);
    expect(hasSufficientCoverage(result({ coveredDays: 22 }), ASKED)).toBe(false);
    expect(hasSufficientCoverage(result({ coveredDays: 23 }), ASKED)).toBe(true);
    expect(hasSufficientCoverage(result({ coveredDays: 28 }), ASKED)).toBe(true);
  });

  it('accepts a fully covered period with no spend', () => {
    expect(hasSufficientCoverage(result({ coveredDays: 28, cost: 0 }), ASKED)).toBe(true);
  });

  it('takes the dateRange as the covered span when a result has no covered days', () => {
    expect(hasSufficientCoverage(result(), ASKED)).toBe(true);
    const lastWeek = { start: asDateString('2026-01-25'), end: asDateString('2026-01-31') };
    expect(hasSufficientCoverage(result({ dateRange: lastWeek }), ASKED)).toBe(false);
  });
});

/** A daily result with spend on the first `spendDays` days of ASKED. */
function dailyResult(spendDays: number, coveredDays?: number): DailyCostsResult {
  const days = Array.from({ length: spendDays }, (_, i) => ({
    date: asDateString(`2026-01-${String(4 + i).padStart(2, '0')}`),
    total: asDollars(10),
    breakdown: { prod: asDollars(10) },
  }));
  return {
    days,
    groups: spendDays === 0 ? [] : ['prod'],
    totalCost: asDollars(spendDays * 10),
    ...(coveredDays === undefined ? {} : { coveredDays }),
  };
}

describe('hasSufficientDailyCoverage', () => {
  it('goes by the covered days the main process reports, not the days with spend', () => {
    expect(hasSufficientDailyCoverage(dailyResult(3, 28), ASKED)).toBe(true);
    expect(hasSufficientDailyCoverage(dailyResult(0, 28), ASKED)).toBe(true);
    expect(hasSufficientDailyCoverage(dailyResult(28, 22), ASKED)).toBe(false);
    expect(hasSufficientDailyCoverage(dailyResult(14, 23), ASKED)).toBe(true);
  });

  it('counts the days with spend when a result has no covered days', () => {
    expect(hasSufficientDailyCoverage(dailyResult(23), ASKED)).toBe(true);
    expect(hasSufficientDailyCoverage(dailyResult(22), ASKED)).toBe(false);
  });
});

/** A daily result with `total` dollars on each of `dates`. */
function daysOn(entries: readonly (readonly [string, number])[]): DailyCostsResult {
  return {
    days: entries.map(([date, total]) => ({ date: asDateString(date), total: asDollars(total), breakdown: { prod: asDollars(total) } })),
    groups: ['prod'],
    totalCost: asDollars(entries.reduce((s, [, t]) => s + t, 0)),
  };
}

describe('previousDayLookup', () => {
  const current: DateRange = { start: asDateString('2026-03-06'), end: asDateString('2026-03-15') };
  const previous: DateRange = { start: asDateString('2026-02-24'), end: asDateString('2026-03-05') };

  it('finds the previous day at the same offset from its period start, whatever days either period skipped', () => {
    const lookup = previousDayLookup(daysOn([['2026-02-25', 12], ['2026-03-02', 99], ['2026-03-04', 25]]), previous, current);
    expect(lookup('2026-03-07')?.total).toBe(12);
    expect(lookup('2026-03-12')?.total).toBe(99);
    expect(lookup('2026-03-14')?.total).toBe(25);
    // Feb 28: a previous day with no rows.
    expect(lookup('2026-03-10')).toBeUndefined();
  });

  it('keeps the offset across months of different lengths', () => {
    const march: DateRange = { start: asDateString('2026-03-01'), end: asDateString('2026-03-31') };
    const before: DateRange = { start: asDateString('2026-01-29'), end: asDateString('2026-02-28') };
    const lookup = previousDayLookup(daysOn([['2026-01-29', 1], ['2026-02-28', 2]]), before, march);
    expect(lookup('2026-03-01')?.total).toBe(1);
    expect(lookup('2026-03-31')?.total).toBe(2);
  });

  it('finds nothing for a date that doesn\'t parse, rather than throwing', () => {
    const lookup = previousDayLookup(daysOn([['2026-02-25', 12]]), previous, current);
    expect(lookup('')).toBeUndefined();
    expect(lookup('not a date')).toBeUndefined();
  });

  it('matches hourly rows hour for hour', () => {
    const lookup = previousDayLookup(daysOn([['2026-02-25 05:00', 3]]), previous, current);
    expect(lookup('2026-03-07 05:00')?.total).toBe(3);
    expect(lookup('2026-03-07 06:00')).toBeUndefined();
  });

  it('shifts by the hours between the starts of a sub-day window', () => {
    const window: DateRange = {
      start: asDateString('2026-03-05'), end: asDateString('2026-03-05'),
      startHour: asHourString('2026-03-05 14:00:00'), endHour: asHourString('2026-03-05 17:00:00'),
    };
    const before: DateRange = {
      start: asDateString('2026-03-05'), end: asDateString('2026-03-05'),
      startHour: asHourString('2026-03-05 10:00:00'), endHour: asHourString('2026-03-05 13:00:00'),
    };
    const lookup = previousDayLookup(daysOn([['2026-03-05 11:00', 4]]), before, window);
    expect(lookup('2026-03-05 15:00')?.total).toBe(4);
  });
});
