import type { BaselineBands, BaselineCurrent, BaselineSavings, BaselineStatus, ManualBand } from '../types/baseline.js';
import type { Dollars } from '../types/branded.js';
import { asDollars } from '../types/branded.js';
import { percentile } from './stats.js';

/** Days assumed per month when projecting daily savings to a monthly figure. */
export const MONTHLY_DAYS = 30;

export interface EffectiveBands {
  readonly lower: Dollars;
  readonly upper: Dollars;
}

/** Resolve the effective band edges. A manual override wins per-side; any unset
 *  side falls back to the automated band. Percentile-mode overrides resolve
 *  against `seriesCosts` (lower excludes zero days, matching the automated
 *  lower band). The result is kept ordered (upper ≥ lower). */
export function effectiveBands(
  automated: BaselineBands,
  manual: ManualBand | undefined,
  seriesCosts: readonly number[],
): EffectiveBands {
  let lower: number = automated.lower;
  let upper: number = automated.upper;
  if (manual !== undefined) {
    if (manual.mode === 'absolute') {
      if (manual.lower !== undefined) lower = manual.lower;
      if (manual.upper !== undefined) upper = manual.upper;
    } else {
      if (manual.lower !== undefined) lower = percentile(seriesCosts, manual.lower, { excludeZero: true });
      if (manual.upper !== undefined) upper = percentile(seriesCosts, manual.upper);
    }
  }
  if (upper < lower) upper = lower;
  return { lower: asDollars(lower), upper: asDollars(upper) };
}

/** potential = how far current sits above the achievable floor (lower band);
 *  realized = how far current sits below the historical ceiling (upper band).
 *  Both floored at 0; monthly = daily × {@link MONTHLY_DAYS}. */
export function computeSavings(current: BaselineCurrent | null, bands: EffectiveBands): BaselineSavings {
  if (current === null) {
    const zero = asDollars(0);
    return { potentialDaily: zero, realizedDaily: zero, potentialMonthly: zero, realizedMonthly: zero };
  }
  const cur = current.avgDaily;
  const potentialDaily = Math.max(0, cur - bands.lower);
  const realizedDaily = Math.max(0, bands.upper - cur);
  return {
    potentialDaily: asDollars(potentialDaily),
    realizedDaily: asDollars(realizedDaily),
    potentialMonthly: asDollars(potentialDaily * MONTHLY_DAYS),
    realizedMonthly: asDollars(realizedDaily * MONTHLY_DAYS),
  };
}

export interface DeriveStatusOptions {
  /** Below this many daily points → insufficient-data. */
  readonly minDataPoints: number;
  /** Current daily under this $ floor → insufficient-data. */
  readonly subCentFloor: number;
  /** When current is inside the band but more than this % above the lower band,
   *  flag it `over` (worth surfacing potential savings). 0 disables. */
  readonly overPctOverLower: number;
}

export function deriveStatus(
  current: BaselineCurrent | null,
  bands: EffectiveBands,
  dataPoints: number,
  opts: DeriveStatusOptions,
): BaselineStatus {
  if (current === null || dataPoints < opts.minDataPoints) return 'insufficient-data';
  const cur = current.avgDaily;
  if (cur < opts.subCentFloor) return 'insufficient-data';
  if (cur < bands.lower) return 'under';
  if (cur > bands.upper) return 'over';
  if (opts.overPctOverLower > 0 && bands.lower > 0 && cur > bands.lower * (1 + opts.overPctOverLower / 100)) {
    return 'over';
  }
  return 'in-band';
}
