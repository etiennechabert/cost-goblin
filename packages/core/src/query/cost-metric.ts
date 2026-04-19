import type { CostMetric } from '../types/cost-scope.js';

const COLUMN_BY_METRIC: Readonly<Record<CostMetric, string>> = {
  unblended: 'line_item_unblended_cost',
  blended: 'line_item_blended_cost',
  list: 'pricing_public_on_demand_cost',
  // TODO: amortized / net_* — need CUR column presence detection first,
  // and a decision on how to handle RI/SP effective cost columns that
  // some users won't have in their export. Keep that work out of the
  // critical path for MVP.
};

/** Raw Parquet column name for a metric. Used only by buildSource to pick
 *  which column becomes the `cost` alias. */
export function costColumnFor(metric: CostMetric): string {
  return COLUMN_BY_METRIC[metric];
}
