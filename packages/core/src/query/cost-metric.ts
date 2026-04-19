import type { CostMetric } from '../types/cost-scope.js';

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
  availableColumns?: ReadonlySet<string>,
): string {
  const has = (col: string): boolean => availableColumns === undefined || availableColumns.has(col);
  switch (metric) {
    case 'unblended':
      // line_item_unblended_cost is the one universal CUR column — if
      // it's missing, every query in the app is broken anyway, so no
      // fallback here.
      return `COALESCE(${prefix}line_item_unblended_cost, 0)`;
    case 'blended':
      // Blended cost is usually present but can be excluded in some CUR
      // configurations. Fall back to unblended when missing.
      if (has('line_item_blended_cost')) {
        return `COALESCE(${prefix}line_item_blended_cost, 0)`;
      }
      return `COALESCE(${prefix}line_item_unblended_cost, 0)`;
    case 'amortized': {
      // Covered usage rows carry a reservation_effective_cost or
      // savings_plan_effective_cost; non-covered rows fall back to
      // unblended. Effective-cost columns only ship when the CUR has
      // "Include Resource IDs" enabled — detect presence and only
      // reference those we actually have. If neither is available,
      // amortized degrades to unblended (unavoidable — no way to
      // recover amortization from data we weren't given).
      const parts: string[] = [];
      if (has('reservation_effective_cost')) parts.push(`${prefix}reservation_effective_cost`);
      if (has('savings_plan_effective_cost')) parts.push(`${prefix}savings_plan_effective_cost`);
      parts.push(`${prefix}line_item_unblended_cost`);
      return `COALESCE(${parts.join(', ')}, 0)`;
    }
  }
}
