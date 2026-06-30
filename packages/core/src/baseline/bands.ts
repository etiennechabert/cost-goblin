import type { BaselineBands, BaselineDailyPoint } from '../types/baseline.js';
import { asDollars } from '../types/branded.js';
import { maxOf, mean, minOf, percentile, stddev } from './stats.js';

export interface ComputeBandsOptions {
  readonly lowerPct: number;
  readonly upperPct: number;
}

/** Compute the automated band + distribution stats over a daily-cost series.
 *  The lower band uses only non-zero days (achievable floor); every other
 *  figure uses all days. */
export function computeBands(series: readonly BaselineDailyPoint[], opts: ComputeBandsOptions): BaselineBands {
  const costs = series.map((p) => p.cost);
  return {
    lower: asDollars(percentile(costs, opts.lowerPct, { excludeZero: true })),
    upper: asDollars(percentile(costs, opts.upperPct)),
    median: asDollars(percentile(costs, 50)),
    mean: asDollars(mean(costs)),
    std: asDollars(stddev(costs)),
    min: asDollars(minOf(costs)),
    max: asDollars(maxOf(costs)),
  };
}
