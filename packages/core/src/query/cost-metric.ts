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

/** Charge categories that carry a list price. Purchase/Tax/Credit/Adjustment
 *  rows have no retail equivalent, and including them just adds zero-cost
 *  rows that bloat group-by buckets — so the `list` metric restricts to
 *  usage rows. Commitment-covered usage remains `ChargeCategory='Usage'`
 *  in FOCUS (flagged via `PricingCategory='Committed'`), so this keeps the
 *  same slice the CUR-era `Usage`/`SavingsPlanCoveredUsage`/`DiscountedUsage`
 *  filter selected. */
export const LIST_METRIC_CHARGE_CATEGORIES: readonly string[] = [
  'Usage',
] as const;
