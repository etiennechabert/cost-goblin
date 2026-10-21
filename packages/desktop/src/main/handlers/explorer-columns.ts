import { usageDateBucketExpr } from '@costgoblin/core';
import type { ExplorerSort, Granularity } from '@costgoblin/core';
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

/** The expression a usage_date row or filter value stands for: the day
 *  itself, or in weekly/monthly the bucket (Monday or first of the month)
 *  the day falls in, cast to text as the renderer sees it. */
function usageDateText(granularity: Granularity | undefined): string {
  return `${usageDateBucketExpr(granularity)}::VARCHAR`;
}

/** `baseWhere` plus one equality per non-empty row filter on an allow-listed
 *  column; filters on anything else are dropped. In weekly/monthly a usage_date
 *  filter compares the bucket, so a "Oct 2026" row drills into all of October. */
export function appendRowFilters(
  baseWhere: string,
  rowFilters: Record<string, string> | undefined,
  tagSqlColumns: ReadonlyMap<string, string>,
  granularity?: Granularity,
): string {
  if (rowFilters === undefined) return baseWhere;
  const extra: string[] = [];
  for (const [id, val] of Object.entries(rowFilters)) {
    if (val.length === 0) continue;
    const col = explorerSqlColumn(id, tagSqlColumns);
    if (col === null) continue;
    const escaped = val.replaceAll("'", "''");
    const colExpr = col === 'usage_date' ? usageDateText(granularity) : col;
    extra.push(`${colExpr} = '${escaped}'`);
  }
  return extra.length === 0 ? baseWhere : andWhere(baseWhere, extra.join(' AND '));
}

/** `where` with `condition` ANDed on, where `where` is a WHERE clause or ''. */
export function andWhere(where: string, condition: string): string {
  return where.length === 0 ? `WHERE ${condition}` : `${where} AND ${condition}`;
}

/** An aggregated-table group-by column: the renderer's id and the SQL column behind it. */
export interface GroupByColumn {
  readonly id: string;
  readonly column: string;
  /** Weekly/monthly usage_date only: the bucket expression the column is
   *  grouped, filtered and sorted by. The result still carries it under
   *  `column`, as the SELECT list aliases it back. */
  readonly bucket?: string;
}

/** The requested group-by ids that resolve to a column, in request order.
 *  A weekly/monthly usage_date groups by its bucket. */
export function explorerGroupBy(
  ids: readonly string[],
  tagSqlColumns: ReadonlyMap<string, string>,
  granularity?: Granularity,
): GroupByColumn[] {
  const dateBucket = usageDateBucketExpr(granularity);
  return ids.flatMap((id): GroupByColumn[] => {
    const column = explorerSqlColumn(id, tagSqlColumns);
    if (column === null) return [];
    return column === 'usage_date' && dateBucket !== 'usage_date'
      ? [{ id, column, bucket: dateBucket }]
      : [{ id, column }];
  });
}

/** The SQL expression a group-by column is grouped and sorted by. */
export function groupByExpression({ column, bucket }: GroupByColumn): string {
  return bucket ?? column;
}

/** The group-by expressions, in column order. */
export function groupByExpressions(groupBy: readonly GroupByColumn[]): string[] {
  return groupBy.map(groupByExpression);
}

/** The group-by SELECT list; usage_date is cast so it survives IPC as a string. */
export function groupBySelectList(groupBy: readonly GroupByColumn[]): string {
  return groupBy
    .map(g => (g.column === 'usage_date' ? `${groupByExpression(g)}::VARCHAR AS usage_date` : g.column))
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
  // By size, so a credit ranks with spend.
  abs_cost: (dir) => `ABS(SUM(cost)) ${dir}`,
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
  if (grouped !== undefined) return `${groupByExpression(grouped)} ${dir}`;
  return 'SUM(cost) DESC';
}
