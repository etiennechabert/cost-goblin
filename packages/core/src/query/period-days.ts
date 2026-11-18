// Which billing-period months a date range has to read.
//
// A provider's raw data is one directory per billing period
// (`raw/daily-2026-10/`), and a period's files do not hold that month's days
// only. Google invoices by Pacific time, so the first hours of the 1st (UTC)
// are in the month before's files, and usage reported late is in the month
// after's. AWS dates some rows up to two months after their period (charges
// for a term that starts later) and a few a month before it (credits). So
// the months a range touches are not the ones to read: a range reads every
// period that holds a row of one of its days, and no other. `PeriodDays`
// says which those are.

/**
 * YYYY-MM month strings that a date range touches, inclusive. The data layout
 * is one directory per billing period (e.g. `daily-2026-03/`), so a 30-day
 * window ending 2026-04-18 only needs 2026-03 and 2026-04 — skipping the other
 * 11+ months of data avoids the Parquet footer reads for those files and is
 * the biggest single perf win for short-window queries over a year of data.
 *
 * Inputs are YYYY-MM-DD strings (as produced by asDateString). Output is sorted
 * ascending and de-duplicated.
 */
export function computePeriodsInRange(dateRange: { readonly start: string; readonly end: string }): string[] {
  const start = new Date(`${dateRange.start}T00:00:00Z`);
  const end = new Date(`${dateRange.end}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const periods: string[] = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor.getTime() <= endMonth.getTime()) {
    const y = cursor.getUTCFullYear();
    const m = cursor.getUTCMonth() + 1;
    periods.push(`${String(y)}-${String(m).padStart(2, '0')}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return periods;
}

/** For each billing-period month on disk (`YYYY-MM`), the UTC days
 *  (`YYYY-MM-DD`) its files hold rows of. */
export type PeriodDays = Readonly<Record<string, readonly string[]>>;

/** What `periodsForRange` reads of a provider (a `ProviderSourceSpec`). */
export interface PeriodSelection {
  readonly availablePeriods?: readonly string[] | undefined;
  readonly periodDays?: PeriodDays | undefined;
}

/** The billing-period months of a provider that a query over `dateRange`
 *  reads, oldest first: every month on disk holding a row of one of the
 *  range's days. The raw path and both rollups ask this one function, so they
 *  read the same periods and a rollup's answer is raw's.
 *
 *  - Without `availablePeriods`, the months the range touches: the caller
 *    knows nothing of what is on disk.
 *  - Without `periodDays`, or for a month it has no entry for (its days
 *    could not be read), the month counts when the range touches it. A row
 *    it holds of another month is then left out, as it was before the days
 *    were known.
 *
 *  Hour bounds are ignored: a range is read by its days. */
export function periodsForRange(
  provider: PeriodSelection,
  dateRange: { readonly start: string; readonly end: string },
): string[] {
  const touched = computePeriodsInRange(dateRange);
  const { availablePeriods, periodDays } = provider;
  if (availablePeriods === undefined) return touched;
  const { start, end } = dateRange;
  return availablePeriods
    .filter((period) => {
      // Own-property lookup: a period is a validated `YYYY-MM`, but the map
      // came through IPC or a test, and `constructor` is no month.
      const days = periodDays !== undefined && Object.hasOwn(periodDays, period) ? periodDays[period] : undefined;
      if (days === undefined) return touched.includes(period);
      return days.some(day => day >= start && day <= end);
    })
    .sort((a, b) => a.localeCompare(b));
}
