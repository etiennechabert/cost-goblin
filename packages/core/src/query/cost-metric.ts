import type { CostMetric } from '../types/cost-scope.js';

/** SQL expression that becomes the `cost` alias in buildSource. A function
 *  rather than a column name so amortized can fold RI/SP effective-cost
 *  columns together via COALESCE — those columns exist only when the CUR
 *  includes resource IDs. Expression is COALESCE-wrapped so a null falls
 *  through to 0, matching the legacy `COALESCE(col, 0) AS cost` shape.
 *
 *  `prefix` is the table qualifier ('cur.' when the source JOINs org
 *  accounts, '' otherwise) — mirrors what buildSource already does for
 *  other column references. */
export function costExprFor(metric: CostMetric, prefix: string): string {
  switch (metric) {
    case 'unblended':
      return `COALESCE(${prefix}line_item_unblended_cost, 0)`;
    case 'blended':
      return `COALESCE(${prefix}line_item_blended_cost, 0)`;
    case 'amortized':
      // Covered usage rows carry a reservation_effective_cost or
      // savings_plan_effective_cost; non-covered rows fall back to the
      // unblended amount. Upfront RIFee / SavingsPlanUpfrontFee line items
      // are typically excluded from an amortized view via an exclusion
      // rule — the default built-in "RI & Savings Plan purchases" handles
      // that when enabled.
      return `COALESCE(${prefix}reservation_effective_cost, ${prefix}savings_plan_effective_cost, ${prefix}line_item_unblended_cost, 0)`;
  }
}
