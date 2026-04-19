import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { TopNBarChart } from '../components/top-n-bar-chart.js';
import type { TopNBar } from '../components/top-n-bar-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';

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
  const query = useQuery(
    () => api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );
  const bars = useMemo(
    () => rowsToBars(query.status === 'success' ? query.data : null),
    [query],
  );

  const label = dimensionLabelFor(dimensions, specGroupBy);

  return (
    <TopNBarChart
      data={bars}
      title={spec.title ?? label}
      subtitle="Click to filter"
      topN={spec.topN ?? 12}
      onBarClick={(name) => { onSetFilter(specGroupBy, asTagValue(name)); }}
      onBarHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: specGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === specGroupBy ? focus.hoveredEntity : null}
    />
  );
}
