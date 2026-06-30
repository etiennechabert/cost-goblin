import { useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { WaterfallChart } from '../components/waterfall-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { formatDollars } from '../components/format.js';
import { asDollars, asTagValue } from '@costgoblin/core/browser';
import type { DimensionId, TrendResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey } from './widget.js';
import { buildWaterfall } from '../lib/waterfall.js';

const ZERO = asDollars(0);

export function WaterfallWidget({ spec, dateRange, globalFilters, dimensions, onSetFilter }: WidgetCommonProps) {
  const api = useCostApi();
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'waterfall' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const topN = spec.type === 'waterfall' ? (spec.topN ?? 8) : 8;
  const fk = filtersKey(globalFilters);

  const query = useQuery<TrendResult | null>(
    () => effectiveGroupBy === undefined
      ? Promise.resolve(null)
      : api.queryTrends({
          groupBy: effectiveGroupBy,
          dateRange,
          filters: globalFilters,
          deltaThreshold: ZERO,
          percentThreshold: 0,
          origin: `widget:waterfall:${String(effectiveGroupBy)}`,
        }),
    [effectiveGroupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, api],
  );

  const model = useMemo(() => {
    if (query.status !== 'success' || query.data === null) return null;
    return buildWaterfall([...query.data.increases, ...query.data.savings], topN);
  }, [query, topN]);

  if (spec.type !== 'waterfall' || effectiveGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, effectiveGroupBy);
  const title = spec.title ?? (
    <GroupByTitle dimensions={dimensions} currentGroupBy={effectiveGroupBy} onGroupByChange={setGroupByOverride} label={label} suffix="bridge" />
  );

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  if (query.status === 'error') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-warning">Query failed: {query.error.message}</div>
    </div>
  );

  if (model === null || model.steps.length <= 2) return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-text-muted">No period-over-period movement to break down.</div>
    </div>
  );

  const subtitle = `${model.netDelta >= 0 ? '+' : ''}${formatDollars(model.netDelta)} vs prev`;

  return (
    <WaterfallChart
      model={model}
      title={title}
      subtitle={subtitle}
      onStepClick={(step) => { if (step.entity !== null) onSetFilter(effectiveGroupBy, asTagValue(step.entity)); }}
    />
  );
}
