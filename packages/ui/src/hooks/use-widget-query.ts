import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import type {
  CostApi,
  CostResult,
  DailyCostsResult,
  DateRange,
  DimensionId,
  FilterMap,
  Granularity,
  QueryState,
  WidgetFilterOverlay,
} from '@costgoblin/core/browser';
import { filtersKey, getDimensionFallbacks, mergeFilters } from '../widgets/widget.js';

interface DailyQueryResult {
  readonly result: DailyCostsResult;
  readonly groupBy: DimensionId;
}

interface CostQueryResult {
  readonly result: CostResult;
  readonly groupBy: DimensionId;
}

async function fetchDailyWithFallback(
  api: CostApi,
  specGroupBy: DimensionId,
  fallbackDims: readonly DimensionId[],
  dateRange: DateRange,
  filters: FilterMap,
  granularity: Granularity,
): Promise<DailyQueryResult> {
  if (fallbackDims.length === 0) {
    const result = await api.queryDailyCosts({ groupBy: specGroupBy, dateRange, filters, granularity });
    return { result, groupBy: specGroupBy };
  }
  const allDims = [specGroupBy, ...fallbackDims];
  const candidates = await Promise.all(
    allDims.map(async dim => ({
      dim,
      result: await api.queryDailyCosts({ groupBy: dim, dateRange, filters, granularity }),
    })),
  );
  for (const c of candidates.slice(0, -1)) {
    if (c.result.groups.length > 1) return { result: c.result, groupBy: c.dim };
  }
  const last = candidates[candidates.length - 1];
  if (last === undefined) throw new Error('empty fallback chain');
  return { result: last.result, groupBy: last.dim };
}

async function fetchCostsWithFallback(
  api: CostApi,
  specGroupBy: DimensionId,
  fallbackDims: readonly DimensionId[],
  dateRange: DateRange,
  filters: FilterMap,
  granularity: Granularity,
): Promise<CostQueryResult> {
  if (fallbackDims.length === 0) {
    const result = await api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity });
    return { result, groupBy: specGroupBy };
  }
  const allDims = [specGroupBy, ...fallbackDims];
  const candidates = await Promise.all(
    allDims.map(async dim => ({
      dim,
      result: await api.queryCosts({ groupBy: dim, dateRange, filters, granularity }),
    })),
  );
  for (const c of candidates.slice(0, -1)) {
    if (c.result.rows.length > 1) return { result: c.result, groupBy: c.dim };
  }
  const last = candidates[candidates.length - 1];
  if (last === undefined) throw new Error('empty fallback chain');
  return { result: last.result, groupBy: last.dim };
}

interface WidgetQueryArgs {
  readonly specGroupBy: DimensionId | undefined;
  readonly dateRange: DateRange;
  readonly granularity: Granularity;
  readonly globalFilters: FilterMap;
  readonly specFilters: WidgetFilterOverlay | undefined;
}

interface DailyWidgetQueryResult {
  readonly query: QueryState<DailyQueryResult | null>;
  readonly activeGroupBy: DimensionId | undefined;
  readonly dailyResult: DailyCostsResult | null;
  readonly filters: FilterMap;
}

export function useDailyWidgetQuery({
  specGroupBy,
  dateRange,
  granularity,
  globalFilters,
  specFilters,
}: WidgetQueryArgs): DailyWidgetQueryResult {
  const api = useCostApi();
  const filters = mergeFilters(globalFilters, specFilters);
  const fk = filtersKey(filters);
  const fallbackDims = useMemo(
    () => specGroupBy === undefined ? [] : getDimensionFallbacks(specGroupBy),
    [specGroupBy],
  );

  const query = useQuery<DailyQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchDailyWithFallback(api, specGroupBy, fallbackDims, dateRange, filters, granularity),
    [specGroupBy, fallbackDims, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const dailyResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, dailyResult, filters };
}

interface CostWidgetQueryResult {
  readonly query: QueryState<CostQueryResult | null>;
  readonly activeGroupBy: DimensionId | undefined;
  readonly costResult: CostResult | null;
  readonly filters: FilterMap;
}

export function useCostWidgetQuery({
  specGroupBy,
  dateRange,
  granularity,
  globalFilters,
  specFilters,
}: WidgetQueryArgs): CostWidgetQueryResult {
  const api = useCostApi();
  const filters = mergeFilters(globalFilters, specFilters);
  const fk = filtersKey(filters);
  const fallbackDims = useMemo(
    () => specGroupBy === undefined ? [] : getDimensionFallbacks(specGroupBy),
    [specGroupBy],
  );

  const query = useQuery<CostQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchCostsWithFallback(api, specGroupBy, fallbackDims, dateRange, filters, granularity),
    [specGroupBy, fallbackDims, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const costResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, costResult, filters };
}
