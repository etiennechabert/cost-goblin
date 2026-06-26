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
function coalesceCol(prefix: string, col: string): string {
  return `COALESCE(${prefix}${col}, 0)`;
}

function unblendedExpr(prefix: string, net: boolean, has: (col: string) => boolean): string {
  if (net && has('line_item_net_unblended_cost')) {
    return coalesceCol(prefix, 'line_item_net_unblended_cost');
  }
  return coalesceCol(prefix, 'line_item_unblended_cost');
}

function listExpr(prefix: string, has: (col: string) => boolean): string {
  // On-demand list price. Net perspective is meaningless here (credits/refunds
  // don't apply to a hypothetical retail rate), so perspective is ignored.
  // When the column isn't present we fall back to unblended so the query still
  // returns numbers rather than zeros — the UI gates this case with a warning.
  if (has('pricing_public_on_demand_cost')) {
    return coalesceCol(prefix, 'pricing_public_on_demand_cost');
  }
  return coalesceCol(prefix, 'line_item_unblended_cost');
}

function amortizedExpr(prefix: string, net: boolean, has: (col: string) => boolean): string {
  // True amortized cost per AWS Cost Explorer's definition, keyed on
  // line_item_type rather than a flat COALESCE:
  //
  //   DiscountedUsage         → reservation_effective_cost
  //                             (per-hour amortized RI value)
  //   SavingsPlanCoveredUsage → savings_plan_savings_plan_effective_cost
  //                             (per-hour amortized SP value)
  //   RIFee / SP*Fee / SP-Negation → 0
  //                             (these are already amortized into the
  //                              covered-usage rows above; counting both
  //                              double-counts the commitment cost)
  //   everything else         → line_item_unblended_cost
  //                             (Usage, Tax, Credit, EdpDiscount,
  //                              BundledDiscount, Refund, …)
  //
  // A plain COALESCE on the effective-cost columns does NOT work here:
  // AWS populates `reservation_effective_cost` and the SP equivalent with
  // 0 (not NULL) for non-applicable rows, so COALESCE returns 0 for every
  // Usage row and silently zeroes out ~90% of cost.
  const litCol = `${prefix}line_item_line_item_type`;
  const unblended = net && has('line_item_net_unblended_cost')
    ? `${prefix}line_item_net_unblended_cost`
    : `${prefix}line_item_unblended_cost`;
  const riCol = ((): string | null => {
    if (net && has('reservation_net_effective_cost')) return `${prefix}reservation_net_effective_cost`;
    if (has('reservation_effective_cost')) return `${prefix}reservation_effective_cost`;
    return null;
  })();
  const spCol = ((): string | null => {
    if (net && has('savings_plan_net_savings_plan_effective_cost')) return `${prefix}savings_plan_net_savings_plan_effective_cost`;
    if (has('savings_plan_savings_plan_effective_cost')) return `${prefix}savings_plan_savings_plan_effective_cost`;
    return null;
  })();

  // Without either effective-cost family, amortized has nothing to amortize
  // against — degrade to unblended, same as the old code.
  if (riCol === null && spCol === null) {
    return `COALESCE(${unblended}, 0)`;
  }

  const branches: string[] = [];
  if (riCol !== null) {
    branches.push(`WHEN ${litCol} = 'DiscountedUsage' THEN COALESCE(${riCol}, ${unblended}, 0)`);
  }
  if (spCol !== null) {
    branches.push(`WHEN ${litCol} = 'SavingsPlanCoveredUsage' THEN COALESCE(${spCol}, ${unblended}, 0)`);
  }
  branches.push(`WHEN ${litCol} IN ('RIFee', 'SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'SavingsPlanNegation') THEN 0`);
  return `CASE ${branches.join(' ')} ELSE COALESCE(${unblended}, 0) END`;
}

export function costExprFor(
  metric: CostMetric,
  prefix: string,
  perspective: CostPerspective = 'gross',
  availableColumns?: ReadonlySet<string>,
): string {
  const has = (col: string): boolean => availableColumns === undefined || availableColumns.has(col);
  const net = perspective === 'net';
  switch (metric) {
    case 'unblended': return unblendedExpr(prefix, net, has);
    case 'amortized': return amortizedExpr(prefix, net, has);
    case 'list': return listExpr(prefix, has);
  }
}

/** Line-item types that carry a list price. RI/SP fee rows have
 *  `pricing_public_on_demand_cost = 0` (no retail equivalent) so the
 *  `list` metric restricts to these types to avoid muddying the picture
 *  with zero-cost rows that still inflate row counts and group-by buckets.
 *
 *  Mirrors what the Backstage AWS Cost plugin filters on. */
export const LIST_METRIC_LINE_ITEM_TYPES: readonly string[] = [
  'Usage',
  'SavingsPlanCoveredUsage',
  'DiscountedUsage',
] as const;
