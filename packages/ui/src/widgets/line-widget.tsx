import { useMemo } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { LineChart } from '../components/line-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { LineSeries } from '../components/line-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters } from './widget.js';

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

/** Build previous period series mapped onto current period dates so lines
 *  overlay by position (day 1 vs day 1). */
function buildPreviousSeries(
  prevData: DailyCostsResult | null,
  currentSeries: readonly LineSeries[],
  currentDates: readonly string[],
): LineSeries[] {
  if (prevData === null || currentSeries.length === 0) return [];
  const names = new Set(currentSeries.map(s => s.name));
  return [...names].map(name => ({
    name,
    points: currentDates.map((date, i) => {
      const prevDay = prevData.days[i];
      return { date, cost: prevDay?.breakdown[name] ?? 0 };
    }),
  }));
}

export function LineWidget({
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
  const specGroupBy = spec.type === 'line' ? spec.groupBy : undefined;
  const topN = spec.type === 'line' ? (spec.topN ?? 6) : 6;
  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const { query, activeGroupBy, dailyResult } = useDailyWidgetQuery({
    specGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const prevQuery = useQuery<DailyCostsResult | null>(
    () => compareEnabled && specGroupBy !== undefined
      ? api.queryDailyCosts({ groupBy: specGroupBy, dateRange: previousDateRange, filters, granularity })
      : Promise.resolve(null),
    [compareEnabled, specGroupBy, previousDateRange.start, previousDateRange.end, fk, granularity, api],
  );

  const series = useMemo(
    () => buildSeries(dailyResult, topN),
    [dailyResult, topN],
  );

  const currentDates = useMemo(
    () => (dailyResult !== null ? dailyResult.days.map(d => d.date) : []),
    [dailyResult],
  );

  const previousSeries = useMemo(
    () => buildPreviousSeries(prevQuery.status === 'success' ? prevQuery.data : null, series, currentDates),
    [prevQuery, series, currentDates],
  );

  if (spec.type !== 'line' || specGroupBy === undefined || activeGroupBy === undefined) return null;

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  return (
    <LineChart
      series={series}
      previousSeries={compareEnabled ? previousSeries : undefined}
      title={spec.title ?? `${label} over time`}
      subtitle={`Top ${String(topN)} • Click to filter, dbl-click to hide`}
      onSeriesClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
    />
  );
}
