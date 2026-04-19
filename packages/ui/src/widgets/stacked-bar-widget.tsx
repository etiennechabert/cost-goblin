import { useMemo, useState } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { StackedBarChart } from '../components/stacked-bar-chart.js';
import type { BarDay } from '../components/stacked-bar-chart.js';
import type { HistogramTab } from '../components/stacked-bar-chart.js';
import { useCostFocus } from '../hooks/use-cost-focus.js';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';

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
  const api = useCostApi();
  const focus = useCostFocus();
  const [tab, setTab] = useState<HistogramTab>('service');
  if (spec.type !== 'stackedBar') return null;
  const specGroupBy = spec.groupBy;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery(
    () => api.queryDailyCosts({ groupBy: specGroupBy, dateRange, filters, granularity }),
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const periodDays = Math.round(
    (new Date(dateRange.end).getTime() - new Date(dateRange.start).getTime()) / (24 * 60 * 60 * 1000),
  ) + 1;
  const useWeekly = periodDays > 90;
  const barDays = useMemo(
    () => dailyToBarDays(query.status === 'success' ? query.data : null, useWeekly),
    [query, useWeekly],
  );
  const loading = query.status === 'loading';

  const title = spec.title
    ?? (granularity === 'hourly' ? 'Hourly Costs' : useWeekly ? 'Weekly Costs' : 'Daily Costs');

  return (
    <StackedBarChart
      days={barDays}
      highlightedGroup={focus.hoveredEntity}
      tab={tab}
      onTabChange={setTab}
      title={title}
      loading={loading}
    />
  );
}
