import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { PieChart } from '../components/pie-chart.js';
import type { PieSlice } from '../components/pie-chart.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import { asDimensionId, asTagValue } from '@costgoblin/core/browser';
import type { CostResult, DimensionId } from '@costgoblin/core/browser';
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
  const specDrillable = spec.drillable === true;
  const specTitle = spec.title;

  const serviceDimId = asDimensionId('service');
  const isServiceDrillable = specDrillable && specGroupBy === serviceDimId;

  const groupBy: DimensionId = isServiceDrillable && focus.serviceDrill.depth === 'service'
    ? asDimensionId('service_family')
    : specGroupBy;

  const baseFilters = mergeFilters(globalFilters, spec.filters);
  const effectiveFilters = isServiceDrillable && focus.serviceDrill.depth === 'service'
    ? { ...baseFilters, [serviceDimId]: asTagValue(focus.serviceDrill.service) }
    : baseFilters;

  const fk = filtersKey(effectiveFilters);
  const query = useQuery(
    () => api.queryCosts({ groupBy, dateRange, filters: effectiveFilters, granularity }),
    [groupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );
  const slices = useMemo(
    () => rowsToSlices(query.status === 'success' ? query.data : null),
    [query],
  );

  const label = dimensionLabelFor(dimensions, specGroupBy);

  function getTitle(): string {
    if (specTitle !== undefined) return specTitle;
    if (!isServiceDrillable) return label;
    if (focus.serviceDrill.depth === 'none') return label;
    if (focus.serviceDrill.depth === 'service') return focus.serviceDrill.service;
    return `${focus.serviceDrill.service} → ${focus.serviceDrill.family}`;
  }

  function getSubtitle(): string {
    if (!isServiceDrillable) return 'Click to filter';
    if (focus.serviceDrill.depth === 'none') return 'Click to drill down';
    if (focus.serviceDrill.depth === 'service') return 'Click to drill deeper';
    return 'Click to go back';
  }

  function handleClick(name: string) {
    if (isServiceDrillable) {
      if (focus.serviceDrill.depth === 'none') {
        dispatch({ type: 'DRILL_SERVICE', service: name });
        return;
      }
      if (focus.serviceDrill.depth === 'service') {
        dispatch({ type: 'DRILL_SERVICE_FAMILY', family: name });
        return;
      }
      dispatch({ type: 'DRILL_UNWIND' });
      return;
    }
    onSetFilter(specGroupBy, asTagValue(name));
  }

  return (
    <PieChart
      data={slices}
      title={getTitle()}
      subtitle={getSubtitle()}
      onSliceClick={handleClick}
      onSliceHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: specGroupBy }); }}
      externalHoveredName={focus.hoveredDimension === specGroupBy ? focus.hoveredEntity : null}
    />
  );
}
