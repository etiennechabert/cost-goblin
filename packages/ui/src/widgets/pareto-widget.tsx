import { useMemo, useState } from 'react';
import { ParetoChart } from '../components/pareto-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';
import { useAggregatedGroups } from '../hooks/use-aggregated-groups.js';
import { buildPareto } from '../lib/concentration.js';

const ROW_LIMIT = 1000;

export function ParetoWidget({ spec, dateRange, previousDateRange, granularity, globalFilters, dimensions, onSetFilter }: WidgetCommonProps) {
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'pareto' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;

  const { status, error, rows, distinctTotal } = useAggregatedGroups({
    groupBy: effectiveGroupBy,
    dateRange,
    previousDateRange,
    comparePrev: false,
    granularity,
    globalFilters,
    rowLimit: ROW_LIMIT,
    origin: `widget:pareto:${String(effectiveGroupBy ?? '')}`,
  });

  const model = useMemo(
    () => buildPareto(rows.map(r => ({ name: r.name, cost: r.cost })), distinctTotal),
    [rows, distinctTotal],
  );

  if (spec.type !== 'pareto' || effectiveGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, effectiveGroupBy);
  const title = spec.title ?? (
    <GroupByTitle dimensions={dimensions} currentGroupBy={effectiveGroupBy} onGroupByChange={setGroupByOverride} label={label} suffix="concentration" />
  );

  if (status === 'loading' || status === 'idle') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  if (status === 'error') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-warning">Query failed: {error?.message ?? 'unknown error'}</div>
    </div>
  );

  if (model.points.length === 0) return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-text-muted">No spend in range.</div>
    </div>
  );

  const groups = model.distinctTotal > 0 ? model.distinctTotal : model.points.length;
  const cutoffText = model.cutoff === null
    ? `${String(model.points.length)} ${label.toLowerCase()} values`
    : `Top ${String(model.cutoff.count)} of ${String(groups)} = 80% of spend`;
  const subtitle = model.capped ? `${cutoffText} · top ${String(ROW_LIMIT)} shown` : cutoffText;

  return (
    <ParetoChart
      model={model}
      title={title}
      subtitle={subtitle}
      onBarClick={(name) => { onSetFilter(effectiveGroupBy, asTagValue(name)); }}
    />
  );
}
