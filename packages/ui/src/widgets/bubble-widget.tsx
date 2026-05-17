import { useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { BubbleChart } from '../components/bubble-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { asDollars } from '@costgoblin/core/browser';
import type { DimensionId, TrendResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';

const DEFAULT_DELTA_THRESHOLD = asDollars(50);
const DEFAULT_PERCENT_THRESHOLD = 5;

function combinedRows(data: TrendResult | null): TrendResult['increases'] {
  if (data === null) return [];
  return [...data.increases, ...data.savings];
}

export function BubbleWidget({
  spec,
  dateRange,
  globalFilters,
  dimensions,
  onEntityClick,
}: WidgetCommonProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'bubble' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery(
    () => effectiveGroupBy === undefined
      ? Promise.resolve(null)
      : api.queryTrends({
          groupBy: effectiveGroupBy,
          dateRange,
          filters,
          deltaThreshold: DEFAULT_DELTA_THRESHOLD,
          percentThreshold: DEFAULT_PERCENT_THRESHOLD,
          origin: `widget:bubble:${String(effectiveGroupBy)}`,
        }),
    [effectiveGroupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, api],
  );

  const data = useMemo(
    () => combinedRows(query.status === 'success' ? query.data : null),
    [query],
  );

  if (spec.type !== 'bubble' || effectiveGroupBy === undefined) return null;
  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">
        {spec.title ?? <GroupByTitle dimensions={dimensions} currentGroupBy={effectiveGroupBy} onGroupByChange={setGroupByOverride} label={dimensionLabelFor(dimensions, effectiveGroupBy)} />}
      </div>
      <BubbleChart
        data={data}
        logScale={spec.logScale}
        onEntityClick={(entity) => { onEntityClick?.(entity, effectiveGroupBy); }}
        externalHoveredName={focus.hoveredDimension === effectiveGroupBy ? focus.hoveredEntity : null}
        onEntityHover={(name) => { dispatch({ type: 'HOVER', entity: name, dimension: effectiveGroupBy }); }}
      />
    </div>
  );
}
