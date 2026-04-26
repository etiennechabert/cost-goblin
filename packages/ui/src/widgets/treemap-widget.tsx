import { useMemo } from 'react';
import { useCostWidgetQuery } from '../hooks/use-widget-query.js';
import { TreemapChart } from '../components/treemap-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { TreemapCell } from '../components/treemap-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';

function rowsToCells(data: CostResult | null): TreemapCell[] {
  if (data === null) return [];
  return data.rows.map(r => ({ name: r.entity, cost: r.totalCost }));
}

export function TreemapWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const specGroupBy = spec.type === 'treemap' ? spec.groupBy : undefined;

  const { query, activeGroupBy, costResult } = useCostWidgetQuery({
    specGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const cells = useMemo(
    () => rowsToCells(costResult),
    [costResult],
  );

  if (spec.type !== 'treemap' || specGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <TreemapChart
      data={cells}
      title={spec.title ?? label}
      subtitle="Click to filter"
      onCellClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
    />
  );
}
