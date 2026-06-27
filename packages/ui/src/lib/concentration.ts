/** Gini coefficient over positive cost values. 0 = perfectly even, approaches
 *  1 as a single value dominates. Uses the mean-absolute-difference form. */
export function gini(values: readonly number[]): number {
  const v = values.filter(x => x > 0).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return 0;
  let numer = 0;
  let total = 0;
  v.forEach((x, idx) => {
    numer += (2 * (idx + 1) - n - 1) * x;
    total += x;
  });
  return total === 0 ? 0 : numer / (n * total);
}

export interface ParetoPoint {
  readonly name: string;
  readonly cost: number;
  readonly cumCost: number;
  /** Cumulative share of the total, 0..1. */
  readonly cumPct: number;
  readonly rank: number;
}

export interface ParetoModel {
  readonly points: readonly ParetoPoint[];
  readonly total: number;
  readonly gini: number;
  /** Smallest prefix of entities reaching `threshold` of total spend. */
  readonly cutoff: { readonly count: number; readonly pct: number } | null;
  /** True when the source rows were capped below the true distinct count, so
   *  the tail past the cap is not represented. */
  readonly capped: boolean;
  readonly distinctTotal: number;
}

/** Build a Pareto (sorted cumulative-share) model plus a Gini badge and the
 *  prefix that reaches `threshold` (default 80%) of spend. `distinctTotal` is the
 *  true number of groups (may exceed `rows.length` when the query was capped). */
export function buildPareto(
  rows: readonly { readonly name: string; readonly cost: number }[],
  distinctTotal: number,
  threshold = 0.8,
): ParetoModel {
  const sorted = rows.filter(r => r.cost > 0).sort((a, b) => b.cost - a.cost);
  const total = sorted.reduce((s, r) => s + r.cost, 0);
  const points: ParetoPoint[] = [];
  let cum = 0;
  let cutoff: { count: number; pct: number } | null = null;
  sorted.forEach((r, i) => {
    cum += r.cost;
    const cumPct = total > 0 ? cum / total : 0;
    points.push({ name: r.name, cost: r.cost, cumCost: cum, cumPct, rank: i + 1 });
    if (cutoff === null && cumPct >= threshold) cutoff = { count: i + 1, pct: cumPct };
  });
  return {
    points,
    total,
    gini: gini(sorted.map(r => r.cost)),
    cutoff,
    // Compare against the rows the backend returned (the cap boundary), not the
    // post-filter count — zero-cost rows being dropped is not truncation.
    capped: distinctTotal > rows.length,
    distinctTotal,
  };
}
