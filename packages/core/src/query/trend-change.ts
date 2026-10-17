/**
 * Period-over-period change for the trend views, defined once for the SQL
 * that reports it per entity and the JS that recomputes it after merging rows
 * (account names shared by several ids, the Trends view netting its buckets).
 * No Node imports: the renderer takes the JS half through the browser entry.
 */

import { assertSafeColumnIdentifier } from './identifier-validator.js';

/** The percent reported for an entity with no cost in the previous period:
 *  +100 for new spend, -100 for a new credit. A change from $0 has no ratio,
 *  so this is a display value, not a magnitude — {@link meetsTrendThresholds}
 *  never holds it against a percent threshold. */
export const NEW_TREND_PERCENT = 100;

/** The shape the threshold check reads; a `TrendRow` satisfies it. */
export interface TrendChange {
  readonly currentCost: number;
  readonly previousCost: number;
  readonly delta: number;
  readonly percentChange: number;
}

/** True for an entity with cost this period and none in the previous one:
 *  new spend, or a new credit. No cost in either period is no change. */
export function isNewTrend(currentCost: number, previousCost: number): boolean {
  return previousCost === 0 && currentCost !== 0;
}

/** Percent change from the previous period, taken against the previous cost's
 *  size so it is always signed like the change, even from a net credit: a
 *  credit growing from -$100 to -$150 is -50%, a saving. ±{@link NEW_TREND_PERCENT}
 *  (signed like the change) when the previous period had no cost, 0 when
 *  neither had any. JS twin of {@link trendPercentChangeSql}; a DuckDB-executed
 *  test pins the two to the same value. */
export function trendPercentChange(currentCost: number, previousCost: number): number {
  if (previousCost === 0) return Math.sign(currentCost) * NEW_TREND_PERCENT;
  return (currentCost - previousCost) / Math.abs(previousCost) * 100;
}

/** SQL twin of {@link trendPercentChange} over two numeric columns. Both are
 *  interpolated bare, so each must be a plain column identifier. */
export function trendPercentChangeSql(current: string, previous: string): string {
  assertSafeColumnIdentifier(current, 'trend percent change');
  assertSafeColumnIdentifier(previous, 'trend percent change');
  return `CASE WHEN ${previous} = 0 THEN SIGN(${current}) * ${String(NEW_TREND_PERCENT)} ELSE (${current} - ${previous}) / ABS(${previous}) * 100 END`;
}

const DAY_MS = 86_400_000;

/** The period a trend compares against: as many days as `range`, ending the
 *  day before it starts — the span the trend SQL buckets as 'previous'. */
export function previousTrendPeriod(range: { readonly start: string; readonly end: string }): { start: string; end: string } {
  const startMs = Date.parse(`${range.start}T00:00:00Z`);
  const days = Math.round((Date.parse(`${range.end}T00:00:00Z`) - startMs) / DAY_MS) + 1;
  return {
    start: new Date(startMs - days * DAY_MS).toISOString().slice(0, 10),
    end: new Date(startMs - DAY_MS).toISOString().slice(0, 10),
  };
}

/** Whether a trend row clears both thresholds. An entity new this period
 *  ({@link isNewTrend}) clears any percent threshold: from $0 its relative
 *  change is unbounded, and comparing its ±100 display value would drop new
 *  spend under any threshold above 100%. */
export function meetsTrendThresholds(row: TrendChange, deltaThreshold: number, percentThreshold: number): boolean {
  if (Math.abs(row.delta) < deltaThreshold) return false;
  if (isNewTrend(row.currentCost, row.previousCost)) return true;
  return Math.abs(row.percentChange) >= percentThreshold;
}
