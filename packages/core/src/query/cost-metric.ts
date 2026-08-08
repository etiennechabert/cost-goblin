import type { CostMetric } from '../types/cost-scope.js';

/** FOCUS 1.2 cost column backing each metric. All four columns are always
 *  present in a FOCUS export — the CUR-era probing/fallback machinery
 *  (effective-cost columns only with resource IDs, net columns only when
 *  enabled, amortization CASE over line item types) is gone. */
const METRIC_COLUMNS: Record<CostMetric, string> = {
  billed: 'BilledCost',
  effective: 'EffectiveCost',
  list: 'ListCost',
  contracted: 'ContractedCost',
};

/** SQL expression that becomes the `cost` alias in buildSource.
 *
 *  `prefix` is the table qualifier ('src.' when the source JOINs org
 *  accounts, '' otherwise) — mirrors what buildSource already does for
 *  other column references.
 *
 *  Expression is COALESCE-wrapped so a null falls through to 0, matching
 *  the legacy `COALESCE(col, 0) AS cost` shape. */
export function costExprFor(metric: CostMetric, prefix: string): string {
  return `COALESCE(${prefix}${METRIC_COLUMNS[metric]}, 0)`;
}

/** Charge categories the rate-comparison metrics (`list` and `contracted`)
 *  restrict to. Purchase/Tax/Credit/Adjustment rows have no retail equivalent,
 *  and for `contracted` they are the source of a double-count: a commitment's
 *  ContractedCost is booked twice under FOCUS — once on the Purchase row
 *  (the commitment fee) and again on the covered `ChargeCategory='Usage'`
 *  rows (flagged `PricingCategory='Committed'`). Summing every category would
 *  count the commitment twice, so both list and contracted are restricted to
 *  usage rows — the same pre/post-negotiation slice, comparable apples-to-apples.
 *  `billed`/`effective` remain the all-rows invoice totals. */
export const USAGE_ONLY_METRIC_CHARGE_CATEGORIES: readonly string[] = [
  'Usage',
] as const;

/** Metrics that report a rate applied to actual usage (as opposed to the
 *  all-rows invoice totals `billed`/`effective`). These restrict to
 *  {@link USAGE_ONLY_METRIC_CHARGE_CATEGORIES}. */
export function isUsageOnlyMetric(metric: CostMetric): boolean {
  return metric === 'list' || metric === 'contracted';
}
