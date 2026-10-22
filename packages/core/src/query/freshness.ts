// The cost scope's freshness lag ("Data freshness"): the most recent `lagDays`
// days are left out of every query that applies the cost scope, because
// billing data for them is still being consolidated. Applied where a query
// receives its range (the desktop IPC handlers, the MCP tools), so every
// consumer gets it whatever range it asks for.
import { DEFAULT_LAG_DAYS } from '../types/cost-scope.js';
import { asDateString, asHourString } from '../types/branded.js';
import type { DateString } from '../types/branded.js';
import type { DateRange } from '../types/query.js';
import { daysBefore } from '../utils/clock.js';

/** The newest day (YYYY-MM-DD) a query may read: `lagDays` days before
 *  `nowMs`, DEFAULT_LAG_DAYS when the cost scope leaves it unset. */
export function freshnessCutoff(nowMs: number, lagDays: number | undefined): DateString {
  return asDateString(daysBefore(nowMs, lagDays ?? DEFAULT_LAG_DAYS));
}

/** `range` with its end moved back to `cutoff` (from {@link freshnessCutoff}),
 *  hour bounds included; a range ending on or before it comes back as is.
 *  Null when the whole range is after the cutoff: nothing in it can be read. */
export function capDateRange(range: DateRange, cutoff: DateString): DateRange | null {
  if (range.start > cutoff) return null;
  if (range.end <= cutoff) return range;
  const { startHour, endHour } = range;
  if (startHour === undefined || endHour === undefined) return { start: range.start, end: cutoff };
  if (startHour.slice(0, 10) > cutoff) return null;
  return {
    start: range.start,
    end: cutoff,
    startHour,
    endHour: endHour.slice(0, 10) > cutoff ? asHourString(`${cutoff} 23:00:00`) : endHour,
  };
}

/** `range` capped at the freshness lag as of `nowMs`; see {@link capDateRange}. */
export function capToFreshnessLag(range: DateRange, nowMs: number, lagDays: number | undefined): DateRange | null {
  return capDateRange(range, freshnessCutoff(nowMs, lagDays));
}
