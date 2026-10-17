import { QueryBuilder, SecurityError } from '@costgoblin/core';
import type { AggregatedTableRow, ExplorerSort } from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';
import { aggregatedOrderBy, groupBySelectList, groupByValues } from './explorer-columns.js';
import type { GroupByColumn } from './explorer-columns.js';
import { toNum } from './query-utils.js';

/** One group's values by group-by id, as in `AggregatedTableRow.values`. */
export type RowKey = Readonly<Record<string, string>>;

/** Runs a query with its bound `$n` parameters. */
export type RunSql = (sql: string, params: readonly unknown[]) => Promise<RawRow[]>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The renderer's `rowKeys`: none, or at most `max` objects of string values.
 *  @throws {SecurityError} for any other payload */
export function parseRowKeys(raw: unknown, max: number): readonly RowKey[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new SecurityError('rowKeys must be a list');
  if (raw.length > max) throw new SecurityError(`rowKeys has ${String(raw.length)} keys, more than the ${String(max)} rows a result can have`);
  return raw.map((entry: unknown): RowKey => {
    if (!isRecord(entry)) throw new SecurityError('each rowKeys entry must be an object');
    const key: Record<string, string> = {};
    for (const [id, value] of Object.entries(entry)) {
      if (typeof value !== 'string') throw new SecurityError(`rowKeys value for "${id}" must be a string`);
      key[id] = value;
    }
    return key;
  });
}

/** Which groups a query keeps for its `rowKeys`. */
export type RowKeysFilter =
  | { readonly kind: 'all' }
  | { readonly kind: 'none' }
  | { readonly kind: 'some'; readonly condition: string };

/** The groups `rowKeys` lists: a key keeps the group with its value on every
 *  group-by column, read as `groupByValues` reads it (a NULL reads as ''),
 *  and a key without such a value keeps none. The values are bound through
 *  `qb`; a table with no group-by has one total row, which any key keeps. */
export function rowKeysFilter(rowKeys: readonly RowKey[] | undefined, groupBy: readonly GroupByColumn[], qb: QueryBuilder): RowKeysFilter {
  if (rowKeys === undefined) return { kind: 'all' };
  if (groupBy.length === 0) return rowKeys.length === 0 ? { kind: 'none' } : { kind: 'all' };
  // Own properties only: a key is renderer data, so `toString` must not
  // read as a value.
  const usable = rowKeys.filter(key => groupBy.every(({ id }) => Object.hasOwn(key, id)));
  if (usable.length === 0) return { kind: 'none' };
  const columns = groupBy.map(({ column }) => `COALESCE(CAST(${column} AS VARCHAR), '')`).join(', ');
  const rows = usable.map(key => `row(${groupBy.map(({ id }) => qb.addParam(key[id])).join(', ')})`).join(', ');
  return { kind: 'some', condition: `row(${columns}) IN (${rows})` };
}

/** `where` with `condition` ANDed on, where `where` is a WHERE clause or ''. */
export function andWhere(where: string, condition: string): string {
  return where.length === 0 ? `WHERE ${condition}` : `${where} AND ${condition}`;
}

export interface AggregatedRowsQuery {
  readonly source: string;
  /** The WHERE clause every line item must pass, or ''. */
  readonly where: string;
  readonly groupBy: readonly GroupByColumn[];
  readonly sort: ExplorerSort | undefined;
  readonly rowLimit: number;
  readonly rowKeys: readonly RowKey[] | undefined;
}

function toAggregatedRow(r: RawRow, groupBy: readonly GroupByColumn[]): AggregatedTableRow {
  return {
    values: groupByValues(r, groupBy),
    cost: toNum(r['cost']),
    listCost: toNum(r['list_cost']),
    usageAmount: toNum(r['usage_amount']),
    rowCount: toNum(r['row_count']),
  };
}

/** The aggregated table's rows (the first `rowLimit` groups in `sort` order,
 *  or the one total row without a group-by) and how many groups pass. */
export async function queryAggregatedRows(run: RunSql, q: AggregatedRowsQuery): Promise<{ rows: AggregatedTableRow[]; totalRows: number }> {
  const qb = new QueryBuilder();
  const keys = rowKeysFilter(q.rowKeys, q.groupBy, qb);
  if (keys.kind === 'none') return { rows: [], totalRows: 0 };
  const where = keys.kind === 'some' ? andWhere(q.where, keys.condition) : q.where;
  const { params } = qb.build();

  if (q.groupBy.length === 0) {
    const sql = `
      SELECT
        CAST(SUM(cost) AS DOUBLE) AS cost,
        CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
        CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount,
        CAST(COUNT(*) AS DOUBLE) AS row_count
      FROM ${q.source}
      ${where}
    `.trim();
    const r = (await run(sql, params))[0];
    if (r === undefined) return { rows: [], totalRows: 0 };
    return { rows: [toAggregatedRow(r, q.groupBy)], totalRows: 1 };
  }

  const groupByList = q.groupBy.map(g => g.column).join(', ');
  const countSql = `
    SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM (
      SELECT 1 FROM ${q.source} ${where}
      GROUP BY ${groupByList}
    ) AS _cnt
  `.trim();
  const dataSql = `
    SELECT
      ${groupBySelectList(q.groupBy)},
      CAST(SUM(cost) AS DOUBLE) AS cost,
      CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
      CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount,
      CAST(COUNT(*) AS DOUBLE) AS row_count
    FROM ${q.source}
    ${where}
    GROUP BY ${groupByList}
    ORDER BY ${aggregatedOrderBy(q.sort, q.groupBy)}
    LIMIT ${String(q.rowLimit)}
  `.trim();

  const [countResult, dataResult] = await Promise.all([run(countSql, params), run(dataSql, params)]);
  const totalRows = countResult[0] === undefined ? 0 : toNum(countResult[0]['n']);
  return { rows: dataResult.map(r => toAggregatedRow(r, q.groupBy)), totalRows };
}
