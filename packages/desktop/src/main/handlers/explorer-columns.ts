import { usageDateBucketExpr } from '@costgoblin/core';
import type { ExplorerSort, Granularity, QueryBuilder } from '@costgoblin/core';
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

/** An allow-listed column as a query reads it: the SQL column, and for a
 *  weekly/monthly usage_date the bucket expression (the week's Monday or the
 *  month's first day) it is grouped, filtered and sorted by. A result still
 *  carries a bucket under `column`, as the SELECT list aliases it back. */
export interface ColumnRef {
  readonly column: string;
  readonly bucket?: string;
}

/** `column` as a query reads it at `granularity` (see ColumnRef). */
function columnRef(column: string, granularity: Granularity | undefined): ColumnRef {
  const bucket = usageDateBucketExpr(granularity);
  return column === 'usage_date' && bucket !== 'usage_date' ? { column, bucket } : { column };
}

/** A row filter on an allow-listed column: line items must hold `value` there,
 *  read as a group-by row reads the column (`groupValueExpr`). */
export interface RowFilter extends ColumnRef {
  readonly value: string;
}

/** The row filters on allow-listed columns, each with the SQL column behind
 *  its id; filters on anything else are dropped. An empty value filters too:
 *  it is the value of the group whose line items have none. In weekly/monthly
 *  a usage_date filter holds the bucket, so a "Oct 2026" row drills into all
 *  of October. */
export function explorerRowFilters(
  rowFilters: Readonly<Record<string, string>> | undefined,
  tagSqlColumns: ReadonlyMap<string, string>,
  granularity?: Granularity,
): RowFilter[] {
  if (rowFilters === undefined) return [];
  return Object.entries(rowFilters).flatMap(([id, value]): RowFilter[] => {
    const column = explorerSqlColumn(id, tagSqlColumns);
    return column === null ? [] : [{ ...columnRef(column, granularity), value }];
  });
}

/** One equality per row filter, its value bound through `qb`, on the column
 *  as a group-by row reads it: a row's values keep exactly its group's line
 *  items, so '' keeps a missing tag as well as an empty one. */
export function rowFilterConditions(rowFilters: readonly RowFilter[], qb: QueryBuilder): string[] {
  return rowFilters.map(filter => `${groupValueExpr(filter)} = ${qb.addParam(filter.value)}`);
}

/** `where` with `condition` ANDed on, where `where` is a WHERE clause or ''. */
export function andWhere(where: string, condition: string): string {
  return where.length === 0 ? `WHERE ${condition}` : `${where} AND ${condition}`;
}

/** An aggregated-table group-by column: the renderer's id and the column behind it. */
export interface GroupByColumn extends ColumnRef {
  readonly id: string;
}

/** The requested group-by ids that resolve to a column, in request order.
 *  A weekly/monthly usage_date groups by its bucket. */
export function explorerGroupBy(
  ids: readonly string[],
  tagSqlColumns: ReadonlyMap<string, string>,
  granularity?: Granularity,
): GroupByColumn[] {
  return ids.flatMap((id): GroupByColumn[] => {
    const column = explorerSqlColumn(id, tagSqlColumns);
    return column === null ? [] : [{ id, ...columnRef(column, granularity) }];
  });
}

/** Explorer columns that hold a DATE or a TIMESTAMP. */
const TEMPORAL_COLUMNS: ReadonlySet<string> = new Set(['usage_date', 'usage_hour']);

/** A column's value as its row shows it (`AggregatedTableRow.values`): text,
 *  never NULL. A tag the line item lacks (NULL) reads as '' like an empty
 *  one, so the two are one group. A date or an hour is text too: the DuckDB
 *  worker's postMessage turns a DATE or TIMESTAMP into a plain object. A
 *  weekly/monthly usage_date reads as its bucket's first day. The select
 *  list, the keyed rows and the row filters all read a column through this,
 *  so each value a row shows is exactly one group, and filters to exactly
 *  its line items. */
export function groupValueExpr({ column, bucket }: ColumnRef): string {
  return `COALESCE(CAST(${bucket ?? column} AS VARCHAR), '')`;
}

/** What a group-by column groups and sorts on: its value, except that a date
 *  or an hour (or a date's bucket) groups on itself. Its text is never '' and
 *  differs per date or hour, so the groups are the same, without casting
 *  every line item. */
function groupKeyExpr(ref: ColumnRef): string {
  return TEMPORAL_COLUMNS.has(ref.column) ? (ref.bucket ?? ref.column) : groupValueExpr(ref);
}

/** The group-by SELECT list: each group's value under its column's name. */
export function groupBySelectList(groupBy: readonly GroupByColumn[]): string {
  return groupBy.map(g => `${groupValueExpr(g)} AS ${g.column}`).join(', ');
}

/** The GROUP BY list behind `groupBySelectList`. */
export function groupByList(groupBy: readonly GroupByColumn[]): string {
  return groupBy.map(groupKeyExpr).join(', ');
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
  if (grouped !== undefined) return `${groupKeyExpr(grouped)} ${dir}`;
  return 'SUM(cost) DESC';
}
