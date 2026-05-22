import { useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { BubbleChart } from '../components/bubble-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { asDollars } from '@costgoblin/core/browser';
import type { DimensionId, TrendResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';

// Defaults match the dedicated Trends view (0 / 0) so a freshly-added bubble
// shows every group, not "no movement above $50/5%" which silently looked
// like a stuck loading state on high-cardinality dims.
const DEFAULT_DELTA_THRESHOLD = asDollars(0);
const DEFAULT_PERCENT_THRESHOLD = 0;

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

  const deltaThreshold = spec.type === 'bubble' && spec.deltaThreshold !== undefined
    ? asDollars(spec.deltaThreshold)
    : DEFAULT_DELTA_THRESHOLD;
  const percentThreshold = spec.type === 'bubble' && spec.percentThreshold !== undefined
    ? spec.percentThreshold
    : DEFAULT_PERCENT_THRESHOLD;

  const fk = filtersKey(globalFilters);
  const query = useQuery(
    () => effectiveGroupBy === undefined
      ? Promise.resolve(null)
      : api.queryTrends({
          groupBy: effectiveGroupBy,
          dateRange,
          filters: globalFilters,
          deltaThreshold,
          percentThreshold,
          origin: `widget:bubble:${String(effectiveGroupBy)}`,
        }),
    [effectiveGroupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, api, deltaThreshold, percentThreshold],
  );

  const data = useMemo(
    () => combinedRows(query.status === 'success' ? query.data : null),
    [query],
  );

  if (spec.type !== 'bubble' || effectiveGroupBy === undefined) return null;

  const header = (
    <div className="mb-2">
      {spec.title ?? <GroupByTitle dimensions={dimensions} currentGroupBy={effectiveGroupBy} onGroupByChange={setGroupByOverride} label={dimensionLabelFor(dimensions, effectiveGroupBy)} />}
    </div>
  );

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  if (query.status === 'error') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      {header}
      <div className="flex items-center justify-center h-[260px] text-xs text-warning">
        Query failed: {query.error.message}
      </div>
    </div>
  );

  if (data.length === 0) return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      {header}
      <div className="flex flex-col items-center justify-center h-[260px] text-xs text-text-muted gap-1">
        <span>No groups passed the trend thresholds.</span>
        {(deltaThreshold > 0 || percentThreshold > 0) && (
          <span>Lower &ldquo;Min $&rdquo; / &ldquo;Min %&rdquo; in the widget settings to widen.</span>
        )}
      </div>
    </div>
  );

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      {header}
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
