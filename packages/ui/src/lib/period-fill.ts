import { asDateString, asDollars, isPeriodGranularity, periodStartsInRange } from '@costgoblin/core/browser';
import type { DailyCostsResult, Granularity } from '@costgoblin/core/browser';

interface DayRange {
  readonly start: string;
  readonly end: string;
}

type DayRow = DailyCostsResult['days'][number];

/** `rows` with an empty row (`empty(key)`) for every Weekly/Monthly period the
 *  range touches that has none, oldest first. The query only returns periods
 *  that have cost, so without this a time axis would skip the unfinished
 *  current period, or a month with no spend, and index i would no longer mean
 *  "the i-th period" when two series are laid side by side. Other
 *  granularities are returned as they are. */
export function fillPeriodBuckets<T extends { readonly date: string }>(
  rows: readonly T[],
  range: DayRange,
  granularity: Granularity,
  empty: (date: string) => T,
): T[] {
  if (!isPeriodGranularity(granularity)) return [...rows];
  const existing = new Set(rows.map(r => r.date));
  const filled = [...rows];
  for (const key of periodStartsInRange({ start: asDateString(range.start), end: asDateString(range.end) }, granularity)) {
    if (!existing.has(key)) filled.push(empty(key));
  }
  return filled.sort((a, b) => a.date.localeCompare(b.date));
}

/** `fillPeriodBuckets` for a daily-costs result's rows (empty days cost zero). */
export function fillPeriodDays(
  data: DailyCostsResult | null,
  range: DayRange,
  granularity: Granularity,
): DayRow[] {
  return fillPeriodBuckets(
    data === null ? [] : data.days,
    range,
    granularity,
    date => ({ date: asDateString(date), total: asDollars(0), breakdown: {} }),
  );
}
