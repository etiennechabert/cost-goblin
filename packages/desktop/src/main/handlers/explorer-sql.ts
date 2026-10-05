/** The Explorer's WHERE clauses. Kept apart from the IPC handlers (no electron
 *  import) so they are unit-testable. Every value — dates, filter values,
 *  exclusion-rule values, row-filter values — binds as a $n parameter; only
 *  allow-listed column names and resolved dimension expressions reach the SQL
 *  text (#479). */

import {
  QueryBuilder,
  asDimensionId,
  buildExclusionClauses,
  buildRuleMatchExpr,
} from '@costgoblin/core';
import type { DimensionsConfig, ExclusionRule, ExplorerFilterMap } from '@costgoblin/core';

/** Columns of the Explorer source a sort, group-by or row filter may name,
 *  besides the configured tag columns. */
export const EXPLORER_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
  'usage_date',
  'usage_hour',
  'account_id',
  'account_name',
  'region',
  'service',
  'service_code',
  'service_category',
  'charge_category',
  'pricing_category',
  'commitment_status',
  'operation',
  'sku_meter',
  'description',
  'resource_id',
  'usage_amount',
  'cost',
  'list_cost',
]);

/** A WHERE clause and the values its $n placeholders bind, in order. */
export interface ParameterizedWhere {
  readonly sql: string;
  readonly params: readonly unknown[];
}

/** The Explorer's dimension filters as one predicate (OR within a dimension,
 *  AND across them), the same matching the exclusion rules use: account
 *  display names expand to ids, values are normalized/alias-resolved. Null
 *  when no filter has a value. */
export function buildExplorerFilterPredicate(
  filters: ExplorerFilterMap,
  dimensions: DimensionsConfig,
  accountReverseMap: ReadonlyMap<string, readonly string[]>,
  qb: QueryBuilder,
): string | null {
  const conditions = Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .map(([dimId, values]) => ({
      dimensionId: asDimensionId(dimId),
      values,
    }));
  if (conditions.length === 0) return null;
  const synthetic: ExclusionRule = {
    id: '_explorer_filters',
    name: '_explorer_filters',
    enabled: true,
    builtIn: false,
    conditions,
  };
  return buildRuleMatchExpr(synthetic, dimensions, accountReverseMap, qb);
}

export interface ExplorerWhereInput {
  readonly startStr: string;
  readonly endStr: string;
  readonly startHour?: string | undefined;
  readonly endHour?: string | undefined;
  readonly tier: 'daily' | 'hourly';
  readonly filters: ExplorerFilterMap;
  readonly dimensions: DimensionsConfig;
  readonly accountReverseMap: ReadonlyMap<string, readonly string[]>;
  /** The cost scope's rules, when the request applies the scope. */
  readonly exclusionRules?: readonly ExclusionRule[] | undefined;
}

/** The date window, then the user's filters, then the cost-scope exclusions.
 *  Hour bounds (the histogram's sub-day drag-zoom) replace the day-level
 *  window on the hourly tier — the only tier with `usage_hour`. */
export function buildExplorerWhere(input: ExplorerWhereInput): ParameterizedWhere {
  const { startStr, endStr, startHour, endHour, tier, filters, dimensions, accountReverseMap, exclusionRules } = input;
  const qb = new QueryBuilder();
  const dateClause = startHour !== undefined && endHour !== undefined && tier === 'hourly'
    ? `usage_hour BETWEEN ${qb.addParam(startHour)}::TIMESTAMP AND ${qb.addParam(endHour)}::TIMESTAMP`
    : `usage_date BETWEEN ${qb.addParam(startStr)} AND ${qb.addParam(endStr)}`;
  const filterPredicate = buildExplorerFilterPredicate(filters, dimensions, accountReverseMap, qb);
  const clauses = [
    dateClause,
    ...(filterPredicate === null ? [] : [`(${filterPredicate})`]),
    ...buildExclusionClauses(exclusionRules, dimensions, accountReverseMap, qb),
  ];
  return { sql: `WHERE ${clauses.join(' AND ')}`, params: qb.build().params };
}

/** Narrow `base` to the aggregated table's expanded row: one equality per
 *  allow-listed column (a scalar column or a tag column), its value bound
 *  after `base`'s params. Unknown columns and empty values are skipped. */
export function appendRowFilters(
  base: ParameterizedWhere,
  rowFilters: Readonly<Record<string, string>> | undefined,
  tagIdSet: ReadonlySet<string>,
): ParameterizedWhere {
  if (rowFilters === undefined) return base;
  const qb = new QueryBuilder(base.params);
  const extra: string[] = [];
  for (const [col, val] of Object.entries(rowFilters)) {
    if (val.length === 0) continue;
    if (!EXPLORER_SCALAR_COLUMNS.has(col) && !tagIdSet.has(col)) continue;
    const colExpr = col === 'usage_date' ? `usage_date::VARCHAR` : col;
    extra.push(`${colExpr} = ${qb.addParam(val)}`);
  }
  if (extra.length === 0) return base;
  const joined = extra.join(' AND ');
  return {
    sql: base.sql.length === 0 ? `WHERE ${joined}` : `${base.sql} AND ${joined}`,
    params: qb.build().params,
  };
}
