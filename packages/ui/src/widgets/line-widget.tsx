import { useMemo, useState } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { LineChart } from '../components/line-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { LineSeries } from '../components/line-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DailyCostDay, DailyCostsResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, hasSufficientDailyCoverage, previousDayLookup } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { daysInRange } from '../lib/dates.js';

/** One point per date in `dates`, zero on a date with no row. */
function buildSeries(data: DailyCostsResult | null, dates: readonly string[], topN: number): LineSeries[] {
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

  const byDate = new Map<string, DailyCostDay>(data.days.map(d => [d.date, d]));
  return top.map(name => ({
    name,
    points: dates.map(date => ({ date, cost: byDate.get(date)?.breakdown[name] ?? 0 })),
  }));
}

/** Build previous period series mapped onto current period dates so lines
 *  overlay by position (day 1 vs day 1). */
function buildPreviousSeries(
  previousOf: ((date: string) => DailyCostDay | undefined) | null,
  currentSeries: readonly LineSeries[],
  currentDates: readonly string[],
): LineSeries[] {
  if (previousOf === null || currentSeries.length === 0) return [];
  return currentSeries.map(({ name }) => ({
    name,
    points: currentDates.map(date => ({ date, cost: previousOf(date)?.breakdown[name] ?? 0 })),
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
  const topN = spec.type === 'line' ? (spec.topN ?? 6) : 6;
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

  // Daily: every day of the range, as the stacked bar's bars, so a day with
  // no rows plots as zero and the previous period's spend on it still shows.
  const fillDays = granularity === 'daily' && dateRange.startHour === undefined;
  const currentDates = useMemo(
    () => {
      if (dailyResult === null) return [];
      const returned = dailyResult.days.map(d => d.date);
      if (!fillDays) return returned;
      return [...new Set([...returned, ...daysInRange(dateRange.start, dateRange.end)])].sort((a, b) => a.localeCompare(b));
    },
    [dailyResult, fillDays, dateRange.start, dateRange.end],
  );

  const series = useMemo(
    () => buildSeries(dailyResult, currentDates, topN),
    [dailyResult, currentDates, topN],
  );

  const prevHasCoverage = prevQuery.status === 'success' && prevQuery.data !== null && hasSufficientDailyCoverage(prevQuery.data, previousDateRange);
  const previousOf = useMemo(
    () => (prevHasCoverage ? previousDayLookup(prevQuery.data, previousDateRange, dateRange) : null),
    [prevHasCoverage, prevQuery, previousDateRange, dateRange],
  );
  const previousSeries = useMemo(
    () => buildPreviousSeries(previousOf, series, currentDates),
    [previousOf, series, currentDates],
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
      title={spec.title ?? <GroupByTitle dimensions={dimensions} currentGroupBy={activeGroupBy} onGroupByChange={setGroupByOverride} label={label} suffix="over time" />}
      subtitle={`Top ${String(topN)} • Click to filter, dbl-click to hide`}
      onSeriesClick={(name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
    />
  );
}
