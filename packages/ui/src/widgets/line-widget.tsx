import { useMemo } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { LineChart } from '../components/line-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { LineSeries } from '../components/line-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor } from './widget.js';

function buildSeries(data: DailyCostsResult | null, topN: number): LineSeries[] {
  if (data === null) return [];
  const totals = new Map<string, number>();
  for (const day of data.days) {
    for (const [k, v] of Object.entries(day.breakdown)) {
      totals.set(k, (totals.get(k) ?? 0) + v);
    }
  }
  const top = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([k]) => k);

  return top.map(name => ({
    name,
    points: data.days.map(d => ({
      date: d.date,
      cost: d.breakdown[name] ?? 0,
    })),
  }));
}

export function LineWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const specGroupBy = spec.type === 'line' ? spec.groupBy : undefined;
  const topN = spec.type === 'line' ? (spec.topN ?? 6) : 6;

  const { query, activeGroupBy, dailyResult } = useDailyWidgetQuery({
    specGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const series = useMemo(
    () => buildSeries(dailyResult, topN),
    [dailyResult, topN],
  );

  if (spec.type !== 'line' || specGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <LineChart
      series={series}
      title={spec.title ?? `${label} over time`}
      subtitle={`Top ${String(topN)} • Click to filter, dbl-click to hide`}
      onSeriesClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
    />
  );
}
