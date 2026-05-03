import { useMemo } from 'react';
import { useCostWidgetQuery } from '../hooks/use-widget-query.js';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';

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
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  const specGroupBy = spec.type === 'topNBar' ? spec.groupBy : undefined;

  const { query, activeGroupBy, costResult } = useCostWidgetQuery({
    specGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const bars = useMemo(
    () => rowsToBars(costResult),
    [costResult],
  );

  if (spec.type !== 'topNBar' || specGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

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
