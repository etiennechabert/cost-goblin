import { describe, expect, it } from 'vitest';
import { asDateString, asDollars } from '@costgoblin/core/browser';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import { fillPeriodBuckets, fillPeriodDays } from '../lib/period-fill.js';

interface Row { readonly date: string; readonly cost: number }
const empty = (date: string): Row => ({ date, cost: 0 });

describe('fillPeriodBuckets', () => {
  it('adds the months with no row, current one included, in order', () => {
    const rows: Row[] = [{ date: '2026-08-01', cost: 5 }, { date: '2026-10-01', cost: 7 }];
    const filled = fillPeriodBuckets(rows, { start: '2026-07-01', end: '2026-10-31' }, 'monthly', empty);
    expect(filled).toEqual([
      { date: '2026-07-01', cost: 0 },
      { date: '2026-08-01', cost: 5 },
      { date: '2026-09-01', cost: 0 },
      { date: '2026-10-01', cost: 7 },
    ]);
  });

  it('fills ISO weeks keyed by their Monday, from a range that starts mid-week', () => {
    const filled = fillPeriodBuckets<Row>([], { start: '2026-10-07', end: '2026-10-21' }, 'weekly', empty);
    expect(filled.map(r => r.date)).toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
  });

  it('leaves Daily and Hourly rows exactly as they are', () => {
    const rows: Row[] = [{ date: '2026-10-02', cost: 1 }];
    expect(fillPeriodBuckets(rows, { start: '2026-10-01', end: '2026-10-05' }, 'daily', empty)).toEqual(rows);
    expect(fillPeriodBuckets(rows, { start: '2026-10-01', end: '2026-10-05' }, 'hourly', empty)).toEqual(rows);
  });
});

describe('fillPeriodDays', () => {
  it('zero-fills the missing periods of a daily-costs result, and an absent result is all zeros', () => {
    const data: DailyCostsResult = {
      days: [{ date: asDateString('2026-09-01'), total: asDollars(9), breakdown: { a: asDollars(9) } }],
      groups: ['a'],
      totalCost: asDollars(9),
    };
    const range = { start: '2026-08-01', end: '2026-10-31' };
    expect(fillPeriodDays(data, range, 'monthly')).toEqual([
      { date: '2026-08-01', total: 0, breakdown: {} },
      { date: '2026-09-01', total: 9, breakdown: { a: 9 } },
      { date: '2026-10-01', total: 0, breakdown: {} },
    ]);
    expect(fillPeriodDays(null, range, 'monthly').map(d => d.date)).toEqual(['2026-08-01', '2026-09-01', '2026-10-01']);
    expect(fillPeriodDays(null, range, 'daily')).toEqual([]);
  });
});
