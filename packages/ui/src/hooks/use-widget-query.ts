import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import type { CostApi } from '@costgoblin/core/browser';
import type {
  CostResult,
  DailyCostsResult,
  DateRange,
  DimensionId,
  FilterMap,
  Granularity,
  QueryState,
} from '@costgoblin/core/browser';
import { filtersKey, getDimensionFallback, mergeFilters } from '../widgets/widget.js';

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
  fallbackDim: DimensionId | undefined,
  dateRange: DateRange,
  filters: FilterMap,
  granularity: Granularity,
): Promise<DailyQueryResult> {
  if (fallbackDim === undefined) {
    const result = await api.queryDailyCosts({ groupBy: specGroupBy, dateRange, filters, granularity });
    return { result, groupBy: specGroupBy };
  }
  const [primary, fallback] = await Promise.all([
    api.queryDailyCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    api.queryDailyCosts({ groupBy: fallbackDim, dateRange, filters, granularity }),
  ]);
  if (primary.groups.length > 1) return { result: primary, groupBy: specGroupBy };
  return { result: fallback, groupBy: fallbackDim };
}

async function fetchCostsWithFallback(
  api: CostApi,
  specGroupBy: DimensionId,
  fallbackDim: DimensionId | undefined,
  dateRange: DateRange,
  filters: FilterMap,
  granularity: Granularity,
): Promise<CostQueryResult> {
  if (fallbackDim === undefined) {
    const result = await api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity });
    return { result, groupBy: specGroupBy };
  }
  const [primary, fallback] = await Promise.all([
    api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    api.queryCosts({ groupBy: fallbackDim, dateRange, filters, granularity }),
  ]);
  if (primary.rows.length > 1) return { result: primary, groupBy: specGroupBy };
  return { result: fallback, groupBy: fallbackDim };
}

interface WidgetQueryArgs {
  readonly specGroupBy: DimensionId | undefined;
  readonly dateRange: DateRange;
  readonly granularity: Granularity;
  readonly globalFilters: FilterMap;
  readonly specFilters: FilterMap | undefined;
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
  const fallbackDim = specGroupBy === undefined ? undefined : getDimensionFallback(specGroupBy);

  const query = useQuery<DailyQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchDailyWithFallback(api, specGroupBy, fallbackDim, dateRange, filters, granularity),
    [specGroupBy, fallbackDim, dateRange.start, dateRange.end, fk, granularity, api],
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
  const fallbackDim = specGroupBy === undefined ? undefined : getDimensionFallback(specGroupBy);

  const query = useQuery<CostQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchCostsWithFallback(api, specGroupBy, fallbackDim, dateRange, filters, granularity),
    [specGroupBy, fallbackDim, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const costResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, costResult, filters };
}
