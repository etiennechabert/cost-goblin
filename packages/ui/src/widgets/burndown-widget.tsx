import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { BurndownChart } from '../components/burndown-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { formatDollars } from '../components/format.js';
import { asDimensionId } from '@costgoblin/core/browser';
import type { DailyCostsResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey } from './widget.js';
import { toCumulative, projectPeriodEnd } from '../lib/day-series.js';
import { daysBetween } from '../lib/dates.js';

// Daily totals are independent of the group-by; query a low-cardinality
// built-in column purely to obtain the per-day totals cheaply.
const PACING_GROUP = asDimensionId('account');

export function BurndownWidget({ spec, dateRange, previousDateRange, globalFilters }: WidgetCommonProps) {
  const api = useCostApi();
  const budget = spec.type === 'burndown' ? spec.budget : undefined;
  const fk = filtersKey(globalFilters);

  // Pacing is a per-day concept; always query the daily tier so the hourly
  // toggle (which constrains the range and emits sub-day buckets) can't distort
  // the cumulative curve.
  const curQuery = useQuery<DailyCostsResult>(
    () => api.queryDailyCosts({ groupBy: PACING_GROUP, dateRange, filters: globalFilters, granularity: 'daily', origin: 'widget:burndown' }),
    [dateRange.start, dateRange.end, fk, api],
  );

  const prevQuery = useQuery<DailyCostsResult>(
    () => api.queryDailyCosts({ groupBy: PACING_GROUP, dateRange: previousDateRange, filters: globalFilters, granularity: 'daily', origin: 'widget:burndown/prev' }),
    [previousDateRange.start, previousDateRange.end, fk, api],
  );

  const current = useMemo(
    () => (curQuery.status === 'success' ? toCumulative(curQuery.data.days.map(d => ({ date: d.date, total: d.total })), dateRange.start) : []),
    [curQuery, dateRange.start],
  );
  const previous = useMemo(
    () => (prevQuery.status === 'success' ? toCumulative(prevQuery.data.days.map(d => ({ date: d.date, total: d.total })), previousDateRange.start) : null),
    [prevQuery, previousDateRange.start],
  );

  const totalDays = daysBetween(dateRange.start, dateRange.end);
  const projected = projectPeriodEnd(current, totalDays);

  if (spec.type !== 'burndown') return null;

  const title = spec.title ?? 'Cumulative spend · pacing';

  if (curQuery.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

  if (curQuery.status === 'error') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="text-sm font-medium text-text-secondary mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-warning">Query failed: {curQuery.error.message}</div>
    </div>
  );

  if (current.length === 0) return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <div className="text-sm font-medium text-text-secondary mb-2">{title}</div>
      <div className="flex items-center justify-center h-[240px] text-xs text-text-muted">No spend in range.</div>
    </div>
  );

  let subtitle: string;
  if (projected === null) {
    subtitle = 'Pacing';
  } else if (budget !== undefined && budget > 0) {
    const gap = projected - budget;
    const gapLabel = gap >= 0 ? `${formatDollars(gap)} over` : `${formatDollars(-gap)} under`;
    subtitle = `Projected ${formatDollars(projected)} · ${gapLabel}`;
  } else {
    subtitle = `Projected ${formatDollars(projected)}`;
  }

  return (
    <BurndownChart
      current={current}
      previous={previous}
      totalDays={totalDays}
      projected={projected}
      budget={budget}
      title={title}
      subtitle={subtitle}
    />
  );
}
