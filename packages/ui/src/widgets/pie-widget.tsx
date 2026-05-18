import { useMemo, useState } from 'react';
import { useCostWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { PieChart } from '../components/pie-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { GroupByTitle } from '../components/group-by-title.js';
import type { PieSlice } from '../components/pie-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters, hasSufficientCoverage } from './widget.js';

function rowsToSlices(data: CostResult | null): PieSlice[] {
  if (data === null) return [];
  const total = data.totalCost;
  return data.rows.map(r => ({
    name: r.entity,
    cost: r.totalCost,
    percentage: total > 0 ? (r.totalCost / total) * 100 : 0,
  }));
}

function buildPreviousCostMap(data: CostResult | null): ReadonlyMap<string, number> {
  if (data === null) return new Map();
  return new Map(data.rows.map(r => [r.entity, r.totalCost]));
}

export function PieWidget({
  spec,
  dateRange,
  previousDateRange,
  compareEnabled,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'pie' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const specTitle = spec.title;
  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const origin = `widget:pie:${String(effectiveGroupBy ?? '')}`;
  const { query, activeGroupBy, costResult } = useCostWidgetQuery({
    specGroupBy: effectiveGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
    origin,
  });

  const prevQuery = useQuery<CostResult | null>(
    () => compareEnabled && effectiveGroupBy !== undefined
      ? api.queryCosts({ groupBy: effectiveGroupBy, dateRange: previousDateRange, filters, granularity, origin: `${origin}/prev` })
      : Promise.resolve(null),
    [compareEnabled, effectiveGroupBy, previousDateRange.start, previousDateRange.end, fk, granularity, api, origin],
  );

  const slices = useMemo(
    () => rowsToSlices(costResult),
    [costResult],
  );

  const prevHasCoverage = prevQuery.status === 'success' && prevQuery.data !== null && hasSufficientCoverage(prevQuery.data, previousDateRange);
  const previousCosts = useMemo(
    () => buildPreviousCostMap(prevHasCoverage ? prevQuery.data : null),
    [prevHasCoverage, prevQuery],
  );

  if (spec.type !== 'pie' || effectiveGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4 h-full">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  const showLegend = spec.showLegend !== false;

  return (
    <PieChart
      data={slices}
      title={specTitle ?? <GroupByTitle dimensions={dimensions} currentGroupBy={activeGroupBy} onGroupByChange={setGroupByOverride} label={label} />}
      subtitle="Click to filter"
      onSliceClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
      onSliceHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: activeGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === activeGroupBy ? focus.hoveredEntity : null}
      previousCosts={compareEnabled ? previousCosts : undefined}
      showLegend={showLegend}
    />
  );
}
