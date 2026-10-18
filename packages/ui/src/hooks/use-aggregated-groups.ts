import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import type {
  AggregatedTableParams,
  AggregatedTableResult,
  DateRange,
  DimensionId,
  FilterMap,
  Granularity,
  QueryState,
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
 *  the saved Cost Scope so totals match the rest of the dashboard. */
export function useAggregatedGroups({
  groupBy,
  dateRange,
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

  const rows = useMemo(
    () => (query.status === 'success' && query.data !== null && columnKey !== undefined ? normalize(query.data, columnKey) : []),
    [query, columnKey],
  );

  const distinctTotal = query.status === 'success' && query.data !== null ? query.data.totalRows : 0;

  return {
    status: query.status,
    error: query.status === 'error' ? query.error : null,
    columnKey,
    rows,
    distinctTotal,
  };
}

/** One group in two periods: its row in each, or null where it has no cost. */
export interface AggGroupPair {
  readonly name: string;
  readonly current: AggGroupRow | null;
  readonly previous: AggGroupRow | null;
}

/** Two periods' groups, paired by name. */
export interface PairedGroups {
  /** Every group in either period's top `rowLimit` groups by size, with its
   *  rows in both periods. */
  readonly pairs: readonly AggGroupPair[];
  /** True when a period has more groups than `rowLimit`: the groups ranked
   *  past it in both periods are left out. */
  readonly capped: boolean;
}

interface UsePairedGroupsArgs extends UseAggregatedGroupsArgs {
  readonly previousDateRange: DateRange;
}

/** A period's top groups, and whether the row limit cut any. */
interface PeriodTop {
  readonly rows: readonly AggGroupRow[];
  readonly capped: boolean;
}

/** The groups in `rows` that `other`'s top rows leave out, to fetch from
 *  `other`'s period. None when `other` wasn't capped: it then holds every
 *  group of its period, so one it leaves out has no cost there. */
function leftOut(rows: readonly AggGroupRow[], other: PeriodTop): string[] {
  if (!other.capped) return [];
  const listed = new Set(other.rows.map(r => r.name));
  return [...new Set(rows.map(r => r.name))].filter(name => !listed.has(name));
}

function pairByName(current: readonly AggGroupRow[], previous: readonly AggGroupRow[]): AggGroupPair[] {
  const currentByName = new Map(current.map(r => [r.name, r]));
  const previousByName = new Map(previous.map(r => [r.name, r]));
  const names = new Set([...currentByName.keys(), ...previousByName.keys()]);
  return [...names].map(name => ({
    name,
    current: currentByName.get(name) ?? null,
    previous: previousByName.get(name) ?? null,
  }));
}

/** Fetch each period's top groups for a dimension, as `useAggregatedGroups`
 *  does, ranked by size so a credit competes with spend for the row limit.
 *  A group in one period's top rows that the other period's capped top rows
 *  leave out is then fetched from that period by key, so every group pairs
 *  with its real cost in both. */
export function usePairedGroups({
  groupBy,
  dateRange,
  previousDateRange,
  granularity,
  globalFilters,
  rowLimit,
  origin,
}: UsePairedGroupsArgs): QueryState<PairedGroups | null> {
  const api = useCostApi();
  const fk = filtersKey(globalFilters);
  const columnKey = groupBy === undefined ? undefined : dimToColumnKey(groupBy);
  const explorerFilters = useMemo(() => toExplorerFilters(globalFilters), [globalFilters]);

  // One query for both periods and the groups they leave out, so a pair's two
  // rows always come from the same inputs: no render can pair one range's
  // rows with another's.
  return useQuery<PairedGroups | null>(
    async () => {
      if (columnKey === undefined) return null;
      const fetchGroups = (range: DateRange, queryOrigin: string, rowKeys?: AggregatedTableParams['rowKeys']) =>
        api.queryAggregatedTable({
          filters: explorerFilters,
          dateRange: range,
          granularity,
          applyCostScope: true,
          groupByColumns: [columnKey],
          sort: { column: 'abs_cost', direction: 'desc' },
          rowLimit,
          ...(rowKeys === undefined ? {} : { rowKeys }),
          origin: queryOrigin,
        });
      const fetchTop = async (range: DateRange, queryOrigin: string): Promise<PeriodTop> => {
        const result = await fetchGroups(range, queryOrigin);
        return { rows: normalize(result, columnKey), capped: result.totalRows > result.rows.length };
      };
      const fetchByName = async (range: DateRange, queryOrigin: string, names: readonly string[]): Promise<AggGroupRow[]> => {
        if (names.length === 0) return [];
        return normalize(await fetchGroups(range, queryOrigin, names.map(name => ({ [columnKey]: name }))), columnKey);
      };

      const [current, previous] = await Promise.all([fetchTop(dateRange, origin), fetchTop(previousDateRange, `${origin}/prev`)]);
      const [currentRest, previousRest] = await Promise.all([
        fetchByName(dateRange, `${origin}/pairs`, leftOut(previous.rows, current)),
        fetchByName(previousDateRange, `${origin}/prev/pairs`, leftOut(current.rows, previous)),
      ]);
      return {
        pairs: pairByName([...current.rows, ...currentRest], [...previous.rows, ...previousRest]),
        capped: current.capped || previous.capped,
      };
    },
    [
      columnKey,
      dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour,
      previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour,
      fk, granularity, rowLimit, api, origin,
    ],
  );
}
