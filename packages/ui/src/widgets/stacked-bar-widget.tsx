import { useMemo } from 'react';
import { daysBetween } from '../lib/dates.js';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { StackedBarChart, type BarDay } from '../components/stacked-bar-chart.js';
import { useCostFocus } from '../hooks/use-cost-focus.js';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';

function getISOWeekStart(dateStr: string): string {
  const d = new Date(dateStr);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function aggregateToWeekly(days: BarDay[]): BarDay[] {
  const weeks = new Map<string, { total: number; breakdown: Record<string, number> }>();
  for (const day of days) {
    const weekStart = getISOWeekStart(day.date);
    let week = weeks.get(weekStart);
    if (week === undefined) {
      week = { total: 0, breakdown: {} };
      weeks.set(weekStart, week);
    }
    week.total += day.total;
    for (const [key, val] of Object.entries(day.breakdown)) {
      week.breakdown[key] = (week.breakdown[key] ?? 0) + val;
    }
  }
  return [...weeks.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({ date, total: data.total, breakdown: data.breakdown }));
}

function dailyToBarDays(data: DailyCostsResult | null, useWeekly: boolean): BarDay[] {
  if (data === null) return [];
  const daily = data.days.map(d => ({
    date: d.date,
    total: d.total,
    breakdown: { ...d.breakdown },
  }));
  return useWeekly ? aggregateToWeekly(daily) : daily;
}

export function StackedBarWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
}: WidgetCommonProps) {
  const focus = useCostFocus();
  const specGroupBy = spec.type === 'stackedBar' ? spec.groupBy : undefined;

  const { query, dailyResult } = useDailyWidgetQuery({
    specGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
  });

  const periodDays = daysBetween(dateRange.start, dateRange.end);
  const useWeekly = periodDays > 90;
  const barDays = useMemo(
    () => dailyToBarDays(dailyResult, useWeekly),
    [dailyResult, useWeekly],
  );

  if (spec.type !== 'stackedBar') return null;

  const loading = query.status === 'loading';

  let defaultTitle = 'Daily Costs';
  if (granularity === 'hourly') defaultTitle = 'Hourly Costs';
  else if (useWeekly) defaultTitle = 'Weekly Costs';
  const title = spec.title ?? defaultTitle;

  return (
    <StackedBarChart
      days={barDays}
      highlightedGroup={focus.hoveredEntity}
      title={title}
      loading={loading}
    />
  );
}
