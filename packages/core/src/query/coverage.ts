import { computePeriodsInRange } from './builder.js';
import type { ProviderSourceSpec } from './builder.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days from `from` to `to`, both inclusive, as UTC-midnight epoch ms. */
function inclusiveDays(from: number, to: number): number {
  return Math.round((to - from) / DAY_MS) + 1;
}

/** Days of `range` (inclusive) that fall in a billing month at least one of
 *  `providers` has on disk for the queried tier: the data a query over the
 *  range can actually see.
 *
 *  It counts data, not spend. A synced month counts in full whether or not
 *  anything in it matches the query's filters, so a filter to a rarely used
 *  service doesn't read as missing data. A month that was never synced
 *  (before the first sync, past retention, not downloaded yet) doesn't count.
 *
 *  Sync stores and prunes whole months (`raw/{tier}-{YYYY-MM}/`), so a month
 *  on disk is taken as complete, even one whose export began mid-month. One
 *  provider holding a month is enough: a provider added later doesn't make
 *  the months before it uncovered. A provider whose months are unknown
 *  (`availablePeriods` undefined) covers every month, as in the source
 *  builder. */
export function coveredDaysInRange(
  range: { readonly start: string; readonly end: string },
  providers: readonly ProviderSourceSpec[],
): number {
  const start = Date.parse(`${range.start}T00:00:00Z`);
  const end = Date.parse(`${range.end}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) return 0;
  if (providers.some(p => p.availablePeriods === undefined)) return inclusiveDays(start, end);

  const synced = new Set(providers.flatMap(p => p.availablePeriods ?? []));
  let days = 0;
  for (const period of computePeriodsInRange(range)) {
    if (!synced.has(period)) continue;
    const year = Number(period.slice(0, 4));
    const month = Number(period.slice(5, 7));
    const monthStart = Date.UTC(year, month - 1, 1);
    const monthEnd = Date.UTC(year, month, 0);
    days += inclusiveDays(Math.max(start, monthStart), Math.min(end, monthEnd));
  }
  return days;
}
