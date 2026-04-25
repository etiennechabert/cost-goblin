import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { PieChart } from '../components/pie-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { PieSlice } from '../components/pie-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, getDimensionFallback, mergeFilters } from './widget.js';

interface PieQueryResult {
  readonly result: CostResult;
  readonly groupBy: DimensionId;
}

function rowsToSlices(data: CostResult | null): PieSlice[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows.map(r => ({
    name: r.entity,
    cost: r.totalCost,
    percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
  }));
}

export function PieWidget({
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
  if (spec.type !== 'pie') return null;
  const specGroupBy = spec.groupBy;
  const specTitle = spec.title;

  const baseFilters = mergeFilters(globalFilters, spec.filters);

  const fk = filtersKey(baseFilters);
  const query = useQuery<PieQueryResult>(
    async () => {
      const primary = await api.queryCosts({ groupBy: specGroupBy, dateRange, filters: baseFilters, granularity });
      const fallbackDim = getDimensionFallback(specGroupBy);
      if (primary.rows.length <= 1 && fallbackDim !== undefined) {
        const fallback = await api.queryCosts({ groupBy: fallbackDim, dateRange, filters: baseFilters, granularity });
        return { result: fallback, groupBy: fallbackDim };
      }
      return { result: primary, groupBy: specGroupBy };
    },
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const activeGroupBy = query.status === 'success' ? query.data.groupBy : specGroupBy;
  const slices = useMemo(
    () => rowsToSlices(query.status === 'success' ? query.data.result : null),
    [query],
  );

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <PieChart
      data={slices}
      title={specTitle ?? label}
      subtitle="Click to filter"
      onSliceClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
      onSliceHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: activeGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === activeGroupBy ? focus.hoveredEntity : null}
    />
  );
}
