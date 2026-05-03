import { useMemo } from 'react';
import { useCostWidgetQuery } from '../hooks/use-widget-query.js';
import { PieChart } from '../components/pie-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { PieSlice } from '../components/pie-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';

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
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  const specGroupBy = spec.type === 'pie' ? spec.groupBy : undefined;
  const specTitle = spec.title;

  const { query, activeGroupBy, costResult } = useCostWidgetQuery({
    specGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const slices = useMemo(
    () => rowsToSlices(costResult),
    [costResult],
  );

  if (spec.type !== 'pie' || specGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 h-full">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

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
