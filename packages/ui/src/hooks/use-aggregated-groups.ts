import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import type {
  AggregatedTableResult,
  DateRange,
  DimensionId,
  FilterMap,
  Granularity,
} from '@costgoblin/core/browser';
import { filtersKey } from '../widgets/widget.js';
import { dimToColumnKey, toExplorerFilters } from '../lib/agg-column.js';

/** One group's aggregate over the period: post-scope cost, list cost, and usage
 *  quantity — everything the concentration / price-volume widgets need. */
export interface AggGroupRow {
  readonly name: string;
  readonly cost: number;
  readonly listCost: number;
  readonly usageAmount: number;
}

interface UseAggregatedGroupsArgs {
  readonly groupBy: DimensionId | undefined;
  readonly dateRange: DateRange;
  readonly previousDateRange: DateRange;
  readonly comparePrev: boolean;
  readonly granularity: Granularity;
  readonly globalFilters: FilterMap;
  readonly rowLimit: number;
  readonly origin: string;
}

interface UseAggregatedGroupsResult {
  readonly status: 'idle' | 'loading' | 'success' | 'error';
  readonly error: Error | null;
  readonly columnKey: string | undefined;
  readonly rows: readonly AggGroupRow[];
  /** True distinct group count, which may exceed `rows.length` when capped. */
  readonly distinctTotal: number;
  /** Previous-period groups keyed by name, or null when compare is off. */
  readonly prevByName: ReadonlyMap<string, AggGroupRow> | null;
}

function normalize(result: AggregatedTableResult, columnKey: string): AggGroupRow[] {
  return result.rows.map(r => ({
    name: r.values[columnKey] ?? '',
    cost: r.cost,
    listCost: r.listCost,
    usageAmount: r.usageAmount,
  }));
}

/** Fetch the top groups for a single dimension via the aggregated-table query
 *  (the only query exposing cost + list_cost + usage_amount together), applying
 *  the saved Cost Scope so totals match the rest of the dashboard. Optionally
 *  fetches the previous period for delta-based widgets. */
export function useAggregatedGroups({
  groupBy,
  dateRange,
  previousDateRange,
  comparePrev,
  granularity,
  globalFilters,
  rowLimit,
  origin,
}: UseAggregatedGroupsArgs): UseAggregatedGroupsResult {
  const api = useCostApi();
  const fk = filtersKey(globalFilters);
  const columnKey = groupBy === undefined ? undefined : dimToColumnKey(groupBy);
  const explorerFilters = useMemo(() => toExplorerFilters(globalFilters), [globalFilters]);

  const query = useQuery<AggregatedTableResult | null>(
    () => columnKey === undefined
      ? Promise.resolve(null)
      : api.queryAggregatedTable({
          filters: explorerFilters,
          dateRange,
          granularity,
          applyCostScope: true,
          groupByColumns: [columnKey],
          sort: { column: 'cost', direction: 'desc' },
          rowLimit,
          origin,
        }),
    [columnKey, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, rowLimit, api, origin],
  );

  const prevQuery = useQuery<AggregatedTableResult | null>(
    () => (!comparePrev || columnKey === undefined)
      ? Promise.resolve(null)
      : api.queryAggregatedTable({
          filters: explorerFilters,
          dateRange: previousDateRange,
          granularity,
          applyCostScope: true,
          groupByColumns: [columnKey],
          sort: { column: 'cost', direction: 'desc' },
          rowLimit,
          origin: `${origin}/prev`,
        }),
    [comparePrev, columnKey, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, fk, granularity, rowLimit, api, origin],
  );

  const rows = useMemo(
    () => (query.status === 'success' && query.data !== null && columnKey !== undefined ? normalize(query.data, columnKey) : []),
    [query, columnKey],
  );

  const distinctTotal = query.status === 'success' && query.data !== null ? query.data.totalRows : 0;

  const prevByName = useMemo(() => {
    if (!comparePrev || prevQuery.status !== 'success' || prevQuery.data === null || columnKey === undefined) return null;
    const m = new Map<string, AggGroupRow>();
    for (const r of normalize(prevQuery.data, columnKey)) m.set(r.name, r);
    return m;
  }, [comparePrev, prevQuery, columnKey]);

  return {
    status: query.status,
    error: query.status === 'error' ? query.error : null,
    columnKey,
    rows,
    distinctTotal,
    prevByName,
  };
}
