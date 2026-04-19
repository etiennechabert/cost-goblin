import type { CostMetric, CostPerspective } from '../types/cost-scope.js';

/** SQL expression that becomes the `cost` alias in buildSource. A function
 *  rather than a column name so amortized can fold RI/SP effective-cost
 *  columns together via COALESCE — those columns exist only when the CUR
 *  includes resource IDs. Expression is COALESCE-wrapped so a null falls
 *  through to 0, matching the legacy `COALESCE(col, 0) AS cost` shape.
 *
 *  `prefix` is the table qualifier ('cur.' when the source JOINs org
 *  accounts, '' otherwise) — mirrors what buildSource already does for
 *  other column references.
 *
 *  `perspective` toggles between gross (as-billed) and net (after
 *  credits/refunds). Net variants ship only when the CUR has "Include
 *  Net Columns" enabled; when missing we fall back to gross so the
 *  query still runs.
 *
 *  `availableColumns` lists the columns the probing code found in the
 *  user's parquet files. Optional: `undefined` means "assume every
 *  column is present" (preserves historic behaviour and keeps this
 *  function usable from places without probe access — e.g. SQL-shape
 *  unit tests). When provided, optional columns missing from the set
 *  are dropped from the expression so the query doesn't error on CURs
 *  that ship without resource IDs / net columns / etc. */
export function costExprFor(
  metric: CostMetric,
  prefix: string,
  perspective: CostPerspective = 'gross',
  availableColumns?: ReadonlySet<string>,
): string {
  const has = (col: string): boolean => availableColumns === undefined || availableColumns.has(col);
  const net = perspective === 'net';
  switch (metric) {
    case 'unblended': {
      // Unblended + net: line_item_net_unblended_cost if available,
      // otherwise fall back to the gross column (universal). Unblended +
      // gross: the one column every CUR has.
      if (net && has('line_item_net_unblended_cost')) {
        return `COALESCE(${prefix}line_item_net_unblended_cost, 0)`;
      }
      return `COALESCE(${prefix}line_item_unblended_cost, 0)`;
    }
    case 'blended': {
      // AWS doesn't publish a `line_item_net_blended_cost` — the net
      // variant of blended isn't a first-class CUR column. Best we can
      // do for blended+net is use net_unblended (closest semantics for
      // net accounting) when available, or fall through to gross
      // blended otherwise. Gross blended falls back to unblended when
      // the column is missing (some stripped-down CURs omit it).
      if (net && has('line_item_net_unblended_cost')) {
        return `COALESCE(${prefix}line_item_net_unblended_cost, 0)`;
      }
      if (has('line_item_blended_cost')) {
        return `COALESCE(${prefix}line_item_blended_cost, 0)`;
      }
      return `COALESCE(${prefix}line_item_unblended_cost, 0)`;
    }
    case 'amortized': {
      // Covered usage rows carry reservation_effective_cost (RI) or
      // savings_plan_savings_plan_effective_cost (SP — the double
      // prefix is AWS's snake_case conversion of
      // savingsPlan/SavingsPlanEffectiveCost); non-covered rows fall
      // back to unblended. Net variants are reservation_net_effective_cost
      // and savings_plan_net_savings_plan_effective_cost, paired with
      // line_item_net_unblended_cost as the fall-through. Any columns
      // missing are dropped from the COALESCE chain.
      const parts: string[] = [];
      if (net) {
        if (has('reservation_net_effective_cost')) parts.push(`${prefix}reservation_net_effective_cost`);
        if (has('savings_plan_net_savings_plan_effective_cost')) parts.push(`${prefix}savings_plan_net_savings_plan_effective_cost`);
        if (has('line_item_net_unblended_cost')) parts.push(`${prefix}line_item_net_unblended_cost`);
      } else {
        if (has('reservation_effective_cost')) parts.push(`${prefix}reservation_effective_cost`);
        if (has('savings_plan_savings_plan_effective_cost')) parts.push(`${prefix}savings_plan_savings_plan_effective_cost`);
      }
      // line_item_unblended_cost is the final, universal fall-through.
      parts.push(`${prefix}line_item_unblended_cost`);
      return `COALESCE(${parts.join(', ')}, 0)`;
    }
  }
}
