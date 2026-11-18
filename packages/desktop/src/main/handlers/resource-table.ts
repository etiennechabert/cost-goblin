import { isQueryCancelled, logger, periodsForRange, QueryBuilder, RESOURCE_ROLLUP_KEY_COLUMNS } from '@costgoblin/core';
import type { AggregatedTableRow, ExplorerSort, ProviderSourceSpec } from '@costgoblin/core';
import type { ResourceRollupSource, ResourceRollupStore } from '../resource-rollup-store.js';
import { queryAggregatedRows } from './aggregated-table.js';
import type { RowKey, RunSql } from './aggregated-table.js';
import type { GroupByColumn, RowFilter } from './explorer-columns.js';

/** A rollup row stands for this many line items. */
const ROLLUP_ROW_COUNT = 'SUM(line_items)';

/** Room for the rounding of two sums of the same numbers taken in different
 *  orders, relative to the bound: a page is only exact when its last row
 *  clears the bound by more than that. */
const BOUND_MARGIN = 1e-9;

/** The sorts whose page the tail bound can prove: costliest first, where a
 *  pair left out would have to cost more than the last row to belong, and
 *  the same by size. Any other order could start with pairs left out. */
type ProvableOrder = 'cost' | 'size';

function provableOrder(sort: ExplorerSort | undefined): ProvableOrder | null {
  if (sort === undefined) return 'cost';
  if (sort.direction !== 'desc') return null;
  if (sort.column === 'cost') return 'cost';
  return sort.column === 'abs_cost' ? 'size' : null;
}

/** A page of groups, and how many groups pass: null when the rollup can't
 *  say, because it leaves pairs out. */
export interface ResourceTableRows {
  readonly rows: AggregatedTableRow[];
  readonly totalRows: number | null;
}

export interface ResourceTableQuery {
  readonly store: ResourceRollupStore;
  readonly providers: readonly ProviderSourceSpec[];
  /** The query's days, already capped at the freshness lag. */
  readonly dateRange: { readonly start: string; readonly end: string };
  readonly tier: 'daily' | 'hourly';
  /** True when the request applies the saved cost scope with its own metric:
   *  the only numbers the rollup holds. */
  readonly usesSavedScope: boolean;
  /** The dashboard filters as a predicate over source columns, or null, and
   *  the columns it reads. */
  readonly filterPredicate: string | null;
  readonly filterColumns: readonly string[];
  readonly groupBy: readonly GroupByColumn[];
  readonly rowFilters: readonly RowFilter[];
  readonly sort: ExplorerSort | undefined;
  readonly rowLimit: number;
  readonly rowKeys: readonly RowKey[] | undefined;
  /** True when the caller takes a page without its group count. */
  readonly deferTotalRows: boolean;
}

/** The (resource, description) pairs a query is limited to, when it names
 *  them: its keys', or the one its row filters fix. Null when it names none. */
function namedPairs(q: ResourceTableQuery): readonly (readonly [string, string])[] | null {
  const [resourceColumn = '', descriptionColumn = ''] = RESOURCE_ROLLUP_KEY_COLUMNS;
  const resourceId = q.groupBy.find(g => g.column === resourceColumn)?.id;
  const descriptionId = q.groupBy.find(g => g.column === descriptionColumn)?.id;
  if (q.rowKeys !== undefined && resourceId !== undefined && descriptionId !== undefined) {
    // Own properties only, as `rowKeysFilter` reads a key.
    return q.rowKeys.flatMap((key): (readonly [string, string])[] => {
      const resource = Object.hasOwn(key, resourceId) ? key[resourceId] : undefined;
      const description = Object.hasOwn(key, descriptionId) ? key[descriptionId] : undefined;
      return resource === undefined || description === undefined ? [] : [[resource, description]];
    });
  }
  const resource = q.rowFilters.find(f => f.column === resourceColumn && f.bucket === undefined)?.value;
  const description = q.rowFilters.find(f => f.column === descriptionColumn && f.bucket === undefined)?.value;
  return resource === undefined || description === undefined ? null : [[resource, description]];
}

/** True when every one of `pairs` is in the heavy set, so the rollup holds
 *  each of them whole. */
async function allHeavy(run: RunSql, served: ResourceRollupSource, pairs: readonly (readonly [string, string])[]): Promise<boolean> {
  const distinct = [...new Map(pairs.map(pair => [JSON.stringify(pair), pair])).values()];
  if (distinct.length === 0) return true;
  const qb = new QueryBuilder();
  const rows = distinct.map(([resource, description]) => `row(${qb.addParam(resource)}, ${qb.addParam(description)})`).join(', ');
  const sql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${served.heavySource} WHERE row(${RESOURCE_ROLLUP_KEY_COLUMNS.join(', ')}) IN (${rows})`;
  const found = (await run(sql, qb.build().params))[0]?.['n'];
  return found === distinct.length;
}

/** Where the query reads the resource rollup, or undefined when it can't:
 *  only a daily table of one provider, in the saved cost scope, grouped by
 *  the resource and its description at least, over billing periods the rollup
 *  has. */
function resolveServed(q: ResourceTableQuery): ResourceRollupSource | undefined {
  const [provider, ...others] = q.providers;
  if (q.tier !== 'daily' || !q.usesSavedScope || provider === undefined || others.length > 0) return undefined;
  const grouped = new Set(q.groupBy.map(g => g.column));
  if (RESOURCE_ROLLUP_KEY_COLUMNS.some(c => !grouped.has(c))) return undefined;
  // The billing periods holding a day of the range, as on the raw path, which
  // reads no others: the tail bounds added up are theirs.
  return q.store.resolveSource({
    requiredPeriods: periodsForRange(provider, q.dateRange),
    neededColumns: [...grouped, ...q.rowFilters.map(f => f.column), ...q.filterColumns],
  });
}

/** The aggregated table read from the resource rollup, or null when the
 *  rollup cannot give the answer raw Parquet would: the caller then reads
 *  raw. Exact in three cases (see resource-rollup.ts in core):
 *
 *  - no month in range leaves a pair out: the rows hold every pair, so any
 *    sort, the keyed rows and the count are right;
 *  - the query names its pairs (the keys of another period's rows, or the row
 *    a detail expands) and every one is heavy: each is stored whole;
 *  - a page of the costliest pairs whose last row costs more than the range's
 *    tail bound: nothing left out can reach it. Such a page comes without its
 *    group count, which only every pair can give. */
export async function queryResourceRollupTable(run: RunSql, q: ResourceTableQuery): Promise<ResourceTableRows | null> {
  const served = resolveServed(q);
  if (served === undefined) return null;
  const filter = q.filterPredicate === null ? '' : ` AND (${q.filterPredicate})`;
  const rollupQuery = {
    source: served.source,
    where: `WHERE usage_date BETWEEN '${q.dateRange.start}' AND '${q.dateRange.end}'${filter}`,
    groupBy: q.groupBy,
    rowFilters: q.rowFilters,
    sort: q.sort,
    rowLimit: q.rowLimit,
    rowKeys: q.rowKeys,
    rowCount: ROLLUP_ROW_COUNT,
  };
  try {
    if (served.complete) return await queryAggregatedRows(run, rollupQuery);
    const pairs = namedPairs(q);
    if (pairs !== null) return await allHeavy(run, served, pairs) ? await queryAggregatedRows(run, rollupQuery) : null;

    const order = provableOrder(q.sort);
    if (order === null || !q.deferTotalRows) return null;
    // The count that comes with the page is of the stored pairs only.
    const page = await queryAggregatedRows(run, rollupQuery);
    const last = page.rows[q.rowLimit - 1];
    // A short page has room for pairs left out, whatever they cost.
    if (last === undefined) return null;
    const reach = order === 'size' ? Math.abs(last.cost) : last.cost;
    const proven = reach > served.tailBound + Math.abs(served.tailBound) * BOUND_MARGIN;
    return proven ? { rows: page.rows, totalRows: null } : null;
  } catch (err: unknown) {
    // Raw Parquet always has the answer: a rollup that can't be read (a file
    // removed under the query) is no reason to fail the table.
    if (isQueryCancelled(err)) throw err;
    logger.warn(`resource-rollup: read failed, reading raw — ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
