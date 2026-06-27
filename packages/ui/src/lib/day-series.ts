export interface CumulativePoint {
  /** 0-based position within the period, so a previous period overlays the
   *  current one by position (day 1 vs day 1) even when month lengths differ. */
  readonly dayIndex: number;
  readonly date: string;
  readonly cumulative: number;
}

/** Running cumulative spend over a daily series, indexed by position. */
export function toCumulative(days: readonly { readonly date: string; readonly total: number }[]): CumulativePoint[] {
  let cum = 0;
  return days.map((d, i) => {
    cum += d.total;
    return { dayIndex: i, date: d.date, cumulative: cum };
  });
}

/** Linear run-rate projection of the period-end total: extrapolate the spend so
 *  far across the full period length. Returns the actual total once the period
 *  is complete, or null when there is nothing to project from. */
export function projectPeriodEnd(points: readonly CumulativePoint[], totalDays: number): number | null {
  const last = points.at(-1);
  if (last === undefined || totalDays <= 0) return null;
  const elapsed = points.length;
  if (elapsed >= totalDays) return last.cumulative;
  return (last.cumulative / elapsed) * totalDays;
}
