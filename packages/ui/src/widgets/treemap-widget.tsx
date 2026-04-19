import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { TreemapChart } from '../components/treemap-chart.js';
import type { TreemapCell } from '../components/treemap-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';

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
  const api = useCostApi();
  if (spec.type !== 'treemap') return null;
  const specGroupBy = spec.groupBy;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery(
    () => api.queryCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const cells = useMemo(
    () => rowsToCells(query.status === 'success' ? query.data : null),
    [query],
  );
  const label = dimensionLabelFor(dimensions, specGroupBy);

  return (
    <TreemapChart
      data={cells}
      title={spec.title ?? label}
      subtitle="Click to filter"
      onCellClick={(name) => { onSetFilter(specGroupBy, asTagValue(name)); }}
    />
  );
}
