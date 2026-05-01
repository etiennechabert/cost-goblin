import { useMemo } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { StackedBarChart, bucketBars, type BarDay } from '../components/stacked-bar-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import { useCostFocus } from '../hooks/use-cost-focus.js';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';

const MAX_BARS = 170;
const DAY_MS = 24 * 60 * 60 * 1000;

function fillDateRange(bars: BarDay[], start: string, end: string): BarDay[] {
  const existing = new Set(bars.map(b => b.date));
  const result = [...bars];
  const current = new Date(start + 'T00:00:00Z');
  const last = new Date(end + 'T00:00:00Z');
  while (current <= last) {
    const dateStr = current.toISOString().slice(0, 10);
    if (!existing.has(dateStr)) {
      result.push({ date: dateStr, total: 0, breakdown: {} });
    }
    current.setTime(current.getTime() + DAY_MS);
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

function dailyToBarDays(data: DailyCostsResult | null): BarDay[] {
  if (data === null) return [];
  return data.days.map(d => ({
    date: d.date,
    total: d.total,
    breakdown: { ...d.breakdown },
  }));
}

function dailyToTotals(data: DailyCostsResult | null): readonly number[] {
  if (data === null) return [];
  return data.days.map(d => d.total);
}

export function StackedBarWidget({
  spec,
  dateRange,
  previousDateRange,
  compareEnabled,
  granularity,
  globalFilters,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const specGroupBy = spec.type === 'stackedBar' ? spec.groupBy : undefined;
  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const { query, dailyResult } = useDailyWidgetQuery({
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

  const barDays = useMemo(
    () => {
      const raw = dailyToBarDays(dailyResult);
      const filled = granularity === 'daily' ? fillDateRange(raw, dateRange.start, dateRange.end) : raw;
      return bucketBars(filled, MAX_BARS);
    },
    [dailyResult, granularity, dateRange.start, dateRange.end],
  );

  const previousTotals = useMemo(
    () => dailyToTotals(prevQuery.status === 'success' ? prevQuery.data : null),
    [prevQuery],
  );

  if (spec.type !== 'stackedBar') return null;

  const loading = query.status === 'loading';

  const defaultTitle = granularity === 'hourly' ? 'Hourly Costs' : 'Daily Costs';
  const title = spec.title ?? defaultTitle;

  return (
    <StackedBarChart
      days={loading ? [] : barDays}
      highlightedGroup={focus.hoveredEntity}
      title={title}
      loading={loading}
      onSegmentClick={specGroupBy === undefined ? undefined : (name) => { onSetFilter(specGroupBy, asTagValue(name)); }}
      previousTotals={compareEnabled ? previousTotals : undefined}
    />
  );
}
