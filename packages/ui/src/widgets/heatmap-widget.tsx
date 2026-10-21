import { useMemo, useState } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { HeatmapChart } from '../components/heatmap-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { HeatmapCell } from '../components/heatmap-chart.js';
import { asTagValue, type DailyCostsResult, type DimensionId, type Granularity } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, topNFor } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { fillPeriodDays } from '../lib/period-fill.js';

interface BuiltCells {
  readonly cells: readonly HeatmapCell[];
  readonly groups: readonly string[];
  readonly dates: readonly string[];
}

function buildCells(days: DailyCostsResult['days'], topN: number): BuiltCells {
  if (days.length === 0) return { cells: [], groups: [], dates: [] };
  const totals = new Map<string, number>();
  for (const day of days) {
    for (const [k, v] of Object.entries(day.breakdown)) {
      totals.set(k, (totals.get(k) ?? 0) + v);
    }
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);
  const cells: HeatmapCell[] = [];
  for (const day of days) {
    for (const g of top) {
      cells.push({ date: day.date, group: g, cost: day.breakdown[g] ?? 0 });
    }
  }
  return {
    cells,
    groups: top,
    dates: days.map(d => d.date),
  };
}

function columnUnit(granularity: Granularity): string {
  if (granularity === 'monthly') return 'Month';
  if (granularity === 'weekly') return 'Week';
  return 'Day';
}

export function HeatmapWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'heatmap' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const topN = topNFor(spec, 'heatmap');

  const { query, activeGroupBy, dailyResult } = useDailyWidgetQuery({
    specGroupBy: effectiveGroupBy,
    dateRange,
    granularity,
    globalFilters,
    origin: `widget:heatmap:${String(effectiveGroupBy ?? '')}`,
  });

  // Weekly/Monthly: every period of the selection is a column, the current
  // unfinished one included.
  const { cells, groups, dates } = useMemo(
    () => buildCells(fillPeriodDays(dailyResult, { start: dateRange.start, end: dateRange.end }, granularity), topN),
    [dailyResult, dateRange.start, dateRange.end, granularity, topN],
  );

  if (spec.type !== 'heatmap' || effectiveGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  return (
    <HeatmapChart
      cells={cells}
      groups={groups}
      dates={dates}
      title={spec.title ?? <GroupByTitle dimensions={dimensions} currentGroupBy={activeGroupBy} onGroupByChange={setGroupByOverride} label={label} suffix={`× ${columnUnit(granularity)}`} />}
      granularity={granularity}
      subtitle="Click a cell to filter"
      onCellClick={(group) => { onSetFilter(activeGroupBy, asTagValue(group)); }}
    />
  );
}
