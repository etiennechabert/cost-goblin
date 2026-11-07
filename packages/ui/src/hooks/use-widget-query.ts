import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import { QUERY_CANCELLED_MESSAGE } from '@costgoblin/core/browser';
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
import { dimensionLabelFor, filtersKey, getDimensionFallbacks } from '../widgets/widget.js';

interface GroupedResult<R> {
  readonly result: R;
  readonly groupBy: DimensionId;
  /** The label of the dimension a chart fell back to. It may be one that's off,
   *  and the `dimensions` a widget gets list only the enabled ones. */
  readonly fallbackLabel?: string;
}

type DailyQueryResult = GroupedResult<DailyCostsResult>;
type CostQueryResult = GroupedResult<CostResult>;

/** `specGroupBy`'s result, unless the filters leave it a single group, which a
 *  chart can't split: then the first fallback dimension that does split it. A
 *  failed fallback only costs the split, so the chart keeps the group it has
 *  rather than drawing nothing. A cancelled one goes on to useQuery to retry. */
async function fetchWithFallback<R>(
  api: CostApi,
  specGroupBy: DimensionId,
  origin: string,
  query: (groupBy: DimensionId, origin: string) => Promise<R>,
  groupCount: (result: R) => number,
): Promise<GroupedResult<R>> {
  const primary = await query(specGroupBy, origin);
  if (groupCount(primary) !== 1) return { result: primary, groupBy: specGroupBy };
  try {
    const config = await api.getDimensionsConfig();
    for (const dim of getDimensionFallbacks(specGroupBy, config)) {
      const result = await query(dim, `${origin}/fallback`);
      if (groupCount(result) > 1) return { result, groupBy: dim, fallbackLabel: dimensionLabelFor(config.builtIn, dim) };
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.message === QUERY_CANCELLED_MESSAGE) throw err;
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
  /** Set when the chart fell back: the label to show for `activeGroupBy`. */
  readonly fallbackLabel: string | undefined;
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

  const query = useQuery<DailyQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchWithFallback(
          api,
          specGroupBy,
          origin,
          (groupBy, queryOrigin) => api.queryDailyCosts({ groupBy, dateRange, filters: globalFilters, granularity, origin: queryOrigin }),
          result => result.groups.length,
        ),
    [specGroupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api, origin],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const fallbackLabel = query.status === 'success' ? query.data?.fallbackLabel : undefined;
  const dailyResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, fallbackLabel, dailyResult, filters: globalFilters };
}

interface CostWidgetQueryResult {
  readonly query: QueryState<CostQueryResult | null>;
  readonly activeGroupBy: DimensionId | undefined;
  /** Set when the chart fell back: the label to show for `activeGroupBy`. */
  readonly fallbackLabel: string | undefined;
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

  const query = useQuery<CostQueryResult | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchWithFallback(
          api,
          specGroupBy,
          origin,
          (groupBy, queryOrigin) => api.queryCosts({ groupBy, dateRange, filters: globalFilters, granularity, origin: queryOrigin }),
          result => result.rows.length,
        ),
    [specGroupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api, origin],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const fallbackLabel = query.status === 'success' ? query.data?.fallbackLabel : undefined;
  const costResult = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, fallbackLabel, costResult, filters: globalFilters };
}
