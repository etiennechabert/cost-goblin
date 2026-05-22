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
} from '@costgoblin/core/browser';
import { filtersKey, getDimensionFallbacks } from '../widgets/widget.js';

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
  origin: string,
): Promise<DailyQueryResult> {
  const primary = await api.queryDailyCosts({ groupBy: specGroupBy, dateRange, filters, granularity, origin });
  if (fallbackDims.length === 0 || primary.groups.length > 1) {
    return { result: primary, groupBy: specGroupBy };
  }
  for (const dim of fallbackDims) {
    const result = await api.queryDailyCosts({ groupBy: dim, dateRange, filters, granularity, origin: `${origin}/fallback` });
    if (result.groups.length > 1) return { result, groupBy: dim };
  }
  return { result: primary, groupBy: specGroupBy };
}

async function fetchCostsWithFallback(
  api: CostApi,
  specGroupBy: DimensionId,
  fallbackDims: readonly DimensionId[],
  dateRange: DateRange,
  filters: FilterMap,
  granularity: Granularity,
  origin: string,
): Promise<CostQueryResult> {
  const primary = await api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity, origin });
  if (fallbackDims.length === 0 || primary.rows.length > 1) {
    return { result: primary, groupBy: specGroupBy };
  }
  for (const dim of fallbackDims) {
    const result = await api.queryCosts({ groupBy: dim, dateRange, filters, granularity, origin: `${origin}/fallback` });
    if (result.rows.length > 1) return { result, groupBy: dim };
  }
  return { result: primary, groupBy: specGroupBy };
}

interface WidgetQueryArgs {
  readonly specGroupBy: DimensionId | undefined;
  readonly dateRange: DateRange;
  readonly granularity: Granularity;
  readonly globalFilters: FilterMap;
  readonly origin: string;
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
  origin,
}: WidgetQueryArgs): DailyWidgetQueryResult {
  const api = useCostApi();
  const fk = filtersKey(globalFilters);
  const fallbackDims = useMemo(
    () => specGroupBy === undefined ? [] : getDimensionFallbacks(specGroupBy),
    [specGroupBy],
  );

  const query = useQuery<DailyQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchDailyWithFallback(api, specGroupBy, fallbackDims, dateRange, globalFilters, granularity, origin),
    [specGroupBy, fallbackDims, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api, origin],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const dailyResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, dailyResult, filters: globalFilters };
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
  origin,
}: WidgetQueryArgs): CostWidgetQueryResult {
  const api = useCostApi();
  const fk = filtersKey(globalFilters);
  const fallbackDims = useMemo(
    () => specGroupBy === undefined ? [] : getDimensionFallbacks(specGroupBy),
    [specGroupBy],
  );

  const query = useQuery<CostQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchCostsWithFallback(api, specGroupBy, fallbackDims, dateRange, globalFilters, granularity, origin),
    [specGroupBy, fallbackDims, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api, origin],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const costResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, costResult, filters: globalFilters };
}
