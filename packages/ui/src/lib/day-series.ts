import { daysBetween } from './dates.js';

export interface CumulativePoint {
  /** 0-based calendar position within the period (day 0 = periodStart), so a
   *  previous period overlays the current one by calendar day and the geometry
   *  stays honest even when zero-cost days are absent from the series. */
  readonly dayIndex: number;
  readonly date: string;
  readonly cumulative: number;
}

/** Running cumulative spend, indexed by calendar offset from `periodStart`.
 *  Days with no spend are absent from `days`; using the calendar offset rather
 *  than the array position keeps the x-axis, projection, and previous-period
 *  overlay correct when interior days are missing. */
export function toCumulative(
  days: readonly { readonly date: string; readonly total: number }[],
  periodStart: string,
): CumulativePoint[] {
  let cum = 0;
  return days.map(d => {
    cum += d.total;
    return { dayIndex: Math.max(daysBetween(periodStart, d.date) - 1, 0), date: d.date, cumulative: cum };
  });
}

/** Linear run-rate projection of the period-end total: spend so far divided by
 *  calendar days elapsed (the latest point's offset + 1), scaled to the full
 *  period. Returns the actual total once the period is complete, or null when
 *  there is nothing to project from. */
export function projectPeriodEnd(points: readonly CumulativePoint[], totalDays: number): number | null {
  const last = points.at(-1);
  if (last === undefined || totalDays <= 0) return null;
  const elapsed = last.dayIndex + 1;
  if (elapsed >= totalDays) return last.cumulative;
  return (last.cumulative / elapsed) * totalDays;
}

/** Cumulative spend at a calendar day: the last point at or before it (a day
 *  with no spend keeps the running total), or 0 before the first spend. */
export function cumulativeAt(points: readonly CumulativePoint[], dayIndex: number): number {
  let value = 0;
  for (const p of points) {
    if (p.dayIndex > dayIndex) break;
    value = p.cumulative;
  }
  return value;
}

/** The run-rate projection line's value at a day after the last actual point,
 *  running from that point to `projected` on the period's last day. Null on or
 *  before the last point, where actual spend applies. */
export function projectedAt(
  points: readonly CumulativePoint[],
  projected: number,
  totalDays: number,
  dayIndex: number,
): number | null {
  const last = points.at(-1);
  if (last === undefined || dayIndex <= last.dayIndex) return null;
  const remaining = totalDays - 1 - last.dayIndex;
  if (remaining <= 0) return null;
  return last.cumulative + ((projected - last.cumulative) * (dayIndex - last.dayIndex)) / remaining;
}
