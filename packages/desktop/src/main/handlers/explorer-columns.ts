import type { ExplorerSort, QueryBuilder } from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';
import { toStr } from './query-utils.js';

/** Explorer columns that are source columns under their own name. */
const SORTABLE_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
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

/** The SQL column behind an Explorer column id: a scalar column is its own
 *  column, a tag id maps through `tagSqlColumns` (see tagSqlColumnsById).
 *  Null for anything else: this is the allow-list that keeps
 *  renderer-supplied ids out of the SQL. */
export function explorerSqlColumn(id: string, tagSqlColumns: ReadonlyMap<string, string>): string | null {
  if (SORTABLE_SCALAR_COLUMNS.has(id)) return id;
  return tagSqlColumns.get(id) ?? null;
}

function sortDirection(sort: ExplorerSort): string {
  return sort.direction === 'asc' ? 'ASC' : 'DESC';
}

/** ORDER BY for the sample rows: the sort column when allow-listed, else |cost|. */
export function explorerOrderBy(sort: ExplorerSort | undefined, tagSqlColumns: ReadonlyMap<string, string>): string {
  if (sort === undefined) return 'ABS(cost) DESC';
  const column = explorerSqlColumn(sort.column, tagSqlColumns);
  if (column === null) return 'ABS(cost) DESC';
  return `${column} ${sortDirection(sort)}`;
}

/** A row filter on an allow-listed column: line items must hold `value` there. */
export interface RowFilter {
  readonly column: string;
  readonly value: string;
}

/** The non-empty row filters on allow-listed columns, each with the SQL column
 *  behind its id; filters on anything else are dropped. */
export function explorerRowFilters(
  rowFilters: Readonly<Record<string, string>> | undefined,
  tagSqlColumns: ReadonlyMap<string, string>,
): RowFilter[] {
  if (rowFilters === undefined) return [];
  return Object.entries(rowFilters).flatMap(([id, value]) => {
    if (value.length === 0) return [];
    const column = explorerSqlColumn(id, tagSqlColumns);
    return column === null ? [] : [{ column, value }];
  });
}

/** One equality per row filter, its value bound through `qb`; usage_date is
 *  compared as text, the form groupBySelectList reads it in. */
export function rowFilterConditions(rowFilters: readonly RowFilter[], qb: QueryBuilder): string[] {
  return rowFilters.map(({ column, value }) => {
    const colExpr = column === 'usage_date' ? `usage_date::VARCHAR` : column;
    return `${colExpr} = ${qb.addParam(value)}`;
  });
}

/** `where` with `condition` ANDed on, where `where` is a WHERE clause or ''. */
export function andWhere(where: string, condition: string): string {
  return where.length === 0 ? `WHERE ${condition}` : `${where} AND ${condition}`;
}

/** An aggregated-table group-by column: the renderer's id and the SQL column behind it. */
export interface GroupByColumn {
  readonly id: string;
  readonly column: string;
}

/** The requested group-by ids that resolve to a column, in request order. */
export function explorerGroupBy(ids: readonly string[], tagSqlColumns: ReadonlyMap<string, string>): GroupByColumn[] {
  return ids.flatMap(id => {
    const column = explorerSqlColumn(id, tagSqlColumns);
    return column === null ? [] : [{ id, column }];
  });
}

/** The group-by SELECT list; usage_date is cast so it survives IPC as a string. */
export function groupBySelectList(groupBy: readonly GroupByColumn[]): string {
  return groupBy
    .map(({ column }) => (column === 'usage_date' ? `usage_date::VARCHAR AS usage_date` : column))
    .join(', ');
}

/** A grouped result row's values, keyed by the renderer's id. */
export function groupByValues(row: RawRow, groupBy: readonly GroupByColumn[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const { id, column } of groupBy) values[id] = toStr(row[column]);
  return values;
}

const AGG_SORT_COLUMNS: Readonly<Record<string, (dir: string) => string>> = {
  cost: (dir) => `SUM(cost) ${dir}`,
  list_cost: (dir) => `SUM(list_cost) ${dir}`,
  usage_amount: (dir) => `SUM(usage_amount) ${dir}`,
  row_count: (dir) => `COUNT(*) ${dir}`,
};

/** ORDER BY for the aggregated table: a measure or a grouped column, else SUM(cost). */
export function aggregatedOrderBy(sort: ExplorerSort | undefined, groupBy: readonly GroupByColumn[]): string {
  if (sort === undefined) return 'SUM(cost) DESC';
  const dir = sortDirection(sort);
  // Own-property read: the sort column comes from the renderer, so a key like
  // `constructor` must not surface prototype members.
  const fn = Object.hasOwn(AGG_SORT_COLUMNS, sort.column) ? AGG_SORT_COLUMNS[sort.column] : undefined;
  if (fn !== undefined) return fn(dir);
  const grouped = groupBy.find(g => g.id === sort.column);
  if (grouped !== undefined) return `${grouped.column} ${dir}`;
  return 'SUM(cost) DESC';
}
