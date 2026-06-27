import type { BaselineDailyPoint } from '../types/baseline.js';
import { mean, stddev } from './stats.js';

export interface PeriodicOptions {
  /** Below this active-day fraction (active days ÷ observed span), the cost is
   *  billed on too few days for a per-day savings band to be meaningful. */
  readonly maxActiveDayFraction: number;
  /** Above this coefficient of variation among active-day costs, the charge
   *  varies day to day — an intermittent workload with a real daily savings
   *  lever — and is NOT treated as a fixed recurring charge. */
  readonly maxActiveDayCoV: number;
  /** Minimum observed span (days) required to classify — fewer can't tell a
   *  monthly charge apart from a young daily scope. */
  readonly minSpanDays: number;
}

const DAY_MS = 86_400_000;

function spanDays(series: readonly BaselineDailyPoint[]): number {
  let min = Infinity;
  let max = -Infinity;
  for (const p of series) {
    const t = Date.parse(`${p.date}T00:00:00Z`);
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (min === Infinity) return 0;
  return Math.round((max - min) / DAY_MS) + 1;
}

/** Whether a scope is a fixed recurring charge billed on a few days (e.g. a
 *  monthly subscription such as the AWS Shield Advanced fee), for which a
 *  per-day savings band is meaningless. Two conditions: its cost lands on a
 *  small fraction of days, AND those active-day amounts are roughly constant.
 *  The variance test is what keeps an intermittent-but-variable workload (which
 *  DOES have a daily savings lever) from being misclassified — its active days
 *  vary, so it fails the coefficient-of-variation test and is left alone. */
export function isPeriodicScope(series: readonly BaselineDailyPoint[], opts: PeriodicOptions): boolean {
  const active = series.filter((p) => p.cost > 0);
  if (active.length === 0) return false;
  const span = spanDays(series);
  if (span < opts.minSpanDays) return false;
  if (active.length / span >= opts.maxActiveDayFraction) return false;
  const costs = active.map((p) => p.cost);
  const m = mean(costs);
  if (m <= 0) return false;
  return stddev(costs) / m < opts.maxActiveDayCoV;
}
