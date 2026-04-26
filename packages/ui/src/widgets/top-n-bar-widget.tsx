import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, getDimensionFallback, mergeFilters } from './widget.js';

interface CostQueryResult {
  readonly result: CostResult;
  readonly groupBy: DimensionId;
}

function rowsToBars(data: CostResult | null): TopNBar[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows.map(r => ({
    name: r.entity,
    cost: r.totalCost,
    percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
  }));
}

export function TopNBarWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  if (spec.type !== 'topNBar') return null;
  const specGroupBy = spec.groupBy;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const fallbackDim = getDimensionFallback(specGroupBy);
  const query = useQuery<CostQueryResult>(
    async () => {
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
    },
    [specGroupBy, fallbackDim, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const activeGroupBy = query.status === 'success' ? query.data.groupBy : specGroupBy;
  const bars = useMemo(
    () => rowsToBars(query.status === 'success' ? query.data.result : null),
    [query],
  );

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <TopNBarChart
      data={bars}
      title={spec.title ?? label}
      subtitle="Click to filter"
      topN={spec.topN ?? 12}
      onBarClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
      onBarHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: activeGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === activeGroupBy ? focus.hoveredEntity : null}
    />
  );
}
