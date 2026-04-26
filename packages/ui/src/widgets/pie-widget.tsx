import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { PieChart } from '../components/pie-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { PieSlice } from '../components/pie-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';

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
  const query = useQuery(
    () => api.queryCosts({ groupBy: specGroupBy, dateRange, filters: baseFilters, granularity }),
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );
  const slices = useMemo(
    () => rowsToSlices(query.status === 'success' ? query.data : null),
    [query],
  );

  const label = dimensionLabelFor(dimensions, specGroupBy);

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <PieChart
      data={slices}
      title={specTitle ?? label}
      subtitle="Click to filter"
      onSliceClick={(name) => { onSetFilter(specGroupBy, asTagValue(name)); }}
      onSliceHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: specGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === specGroupBy ? focus.hoveredEntity : null}
    />
  );
}
