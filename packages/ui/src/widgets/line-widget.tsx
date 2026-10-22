import { useMemo, useState } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { LineChart } from '../components/line-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { LineSeries } from '../components/line-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DailyCostsResult, DimensionId } from '@costgoblin/core/browser';
import { fillPeriodDays } from '../lib/period-fill.js';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, hasSufficientDailyCoverage, topNFor } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';

type Days = DailyCostsResult['days'];

function buildSeries(days: Days, topN: number): LineSeries[] {
  if (days.length === 0) return [];
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

  return top.map(name => ({
    name,
    points: days.map(d => ({
      date: d.date,
      cost: d.breakdown[name] ?? 0,
    })),
  }));
}

/** Build previous period series mapped onto current period dates so lines
 *  overlay by position (day 1 vs day 1). In Weekly/Monthly `prevDays` has one
 *  entry per period (see `fillPeriodDays`), so position still means period. */
function buildPreviousSeries(
  prevDays: Days | null,
  currentSeries: readonly LineSeries[],
  currentDates: readonly string[],
): LineSeries[] {
  if (prevDays === null || currentSeries.length === 0) return [];
  const names = new Set(currentSeries.map(s => s.name));
  return [...names].map(name => ({
    name,
    points: currentDates.map((date, i) => {
      const prevDay = prevDays[i];
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
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'line' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const topN = topNFor(spec, 'line');
  const fk = filtersKey(globalFilters);

  const origin = `widget:line:${String(effectiveGroupBy ?? '')}`;
  const { query, activeGroupBy, dailyResult } = useDailyWidgetQuery({
    specGroupBy: effectiveGroupBy,
    dateRange,
    granularity,
    globalFilters,
    origin,
  });

  const prevQuery = useQuery<DailyCostsResult | null>(
    () => compareEnabled && effectiveGroupBy !== undefined
      ? api.queryDailyCosts({ groupBy: effectiveGroupBy, dateRange: previousDateRange, filters: globalFilters, granularity, origin: `${origin}/prev` })
      : Promise.resolve(null),
    [compareEnabled, effectiveGroupBy, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, fk, granularity, api, origin],
  );

  // Weekly/Monthly: every period of the selection gets a point, the current
  // unfinished one included.
  const days = useMemo(
    () => fillPeriodDays(dailyResult, { start: dateRange.start, end: dateRange.end }, granularity),
    [dailyResult, dateRange.start, dateRange.end, granularity],
  );

  const series = useMemo(
    () => buildSeries(days, topN),
    [days, topN],
  );

  const currentDates = useMemo(
    () => days.map(d => d.date),
    [days],
  );

  const prevHasCoverage = prevQuery.status === 'success' && prevQuery.data !== null && hasSufficientDailyCoverage(prevQuery.data, previousDateRange, granularity);
  const previousDays = useMemo(
    () => (prevHasCoverage ? fillPeriodDays(prevQuery.data, { start: previousDateRange.start, end: previousDateRange.end }, granularity) : null),
    [prevHasCoverage, prevQuery, previousDateRange.start, previousDateRange.end, granularity],
  );
  const previousSeries = useMemo(
    () => buildPreviousSeries(previousDays, series, currentDates),
    [previousDays, series, currentDates],
  );

  if (spec.type !== 'line' || effectiveGroupBy === undefined || activeGroupBy === undefined) return null;

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
      granularity={granularity}
      title={spec.title ?? <GroupByTitle dimensions={dimensions} currentGroupBy={activeGroupBy} onGroupByChange={setGroupByOverride} label={label} suffix="over time" />}
      subtitle={`Top ${String(topN)} • Click to filter, dbl-click to hide`}
      onSeriesClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
    />
  );
}
