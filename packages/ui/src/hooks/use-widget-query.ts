import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import { isQueryCancelled } from '@costgoblin/core/browser';
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
import { dimensionLabelFor, filtersKey, getDimensionFallbacks, hasDimensionFallbacks } from '../widgets/widget.js';

interface GroupedResult<R> {
  readonly result: R;
  readonly groupBy: DimensionId;
  /** The label of the dimension a chart fell back to. It may be one that's off,
   *  and the `dimensions` a widget gets list only the enabled ones. */
  readonly fallbackLabel?: string;
}

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
  if (groupCount(primary) !== 1 || !hasDimensionFallbacks(specGroupBy)) return { result: primary, groupBy: specGroupBy };
  try {
    const config = await api.getDimensionsConfig();
    for (const dim of getDimensionFallbacks(specGroupBy, config)) {
      const result = await query(dim, `${origin}/fallback`);
      if (groupCount(result) > 1) return { result, groupBy: dim, fallbackLabel: dimensionLabelFor(config.builtIn, dim) };
    }
  } catch (err: unknown) {
    if (isQueryCancelled(err)) throw err;
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

interface GroupedQueryParams {
  readonly groupBy: DimensionId;
  readonly dateRange: DateRange;
  readonly filters: FilterMap;
  readonly granularity: Granularity;
  readonly origin: string;
}

interface WidgetQueryState<R> {
  readonly query: QueryState<GroupedResult<R> | null>;
  readonly activeGroupBy: DimensionId | undefined;
  /** Set when the chart fell back: the label to show for `activeGroupBy`. */
  readonly fallbackLabel: string | undefined;
  readonly result: R | null;
}

function useGroupedQuery<R>(
  { specGroupBy, dateRange, granularity, globalFilters, origin }: WidgetQueryArgs,
  run: (api: CostApi, params: GroupedQueryParams) => Promise<R>,
  groupCount: (result: R) => number,
): WidgetQueryState<R> {
  const api = useCostApi();
  const fk = filtersKey(globalFilters);

  const query = useQuery<GroupedResult<R> | null>(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : fetchWithFallback(
          api,
          specGroupBy,
          origin,
          (groupBy, queryOrigin) => run(api, { groupBy, dateRange, filters: globalFilters, granularity, origin: queryOrigin }),
          groupCount,
        ),
    [specGroupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api, origin],
  );

  const activeGroupBy = query.status === 'success' && query.data !== null ? query.data.groupBy : specGroupBy;
  const fallbackLabel = query.status === 'success' ? query.data?.fallbackLabel : undefined;
  const result = useMemo(
    () => (query.status === 'success' && query.data !== null ? query.data.result : null),
    [query],
  );

  return { query, activeGroupBy, fallbackLabel, result };
}

type DailyWidgetQueryResult = Omit<WidgetQueryState<DailyCostsResult>, 'result'> & {
  readonly dailyResult: DailyCostsResult | null;
};

export function useDailyWidgetQuery(args: WidgetQueryArgs): DailyWidgetQueryResult {
  const { result, ...state } = useGroupedQuery(
    args,
    (api, params) => api.queryDailyCosts(params),
    daily => daily.groups.length,
  );
  return { ...state, dailyResult: result };
}

type CostWidgetQueryResult = Omit<WidgetQueryState<CostResult>, 'result'> & {
  readonly costResult: CostResult | null;
};

export function useCostWidgetQuery(args: WidgetQueryArgs): CostWidgetQueryResult {
  const { result, ...state } = useGroupedQuery(
    args,
    (api, params) => api.queryCosts(params),
    costs => costs.rows.length,
  );
  return { ...state, costResult: result };
}
