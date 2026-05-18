import { useCallback, useMemo, useState } from 'react';
import { useDailyWidgetQuery } from '../hooks/use-widget-query.js';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { StackedBarChart, bucketBars, type BarDay } from '../components/stacked-bar-chart.js';
import { asDateString, asHourString, asTagValue } from '@costgoblin/core/browser';
import { useCostFocus, useCostFocusDispatch } from '../hooks/use-cost-focus.js';
import type { DailyCostsResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, mergeFilters, hasSufficientDailyCoverage } from './widget.js';
import { GroupByTitle } from '../components/group-by-title.js';
import { computeBucketedHourRange, computeBucketedRange } from '../lib/drag-select.js';

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
  dimensions,
  onSetFilter,
  onDateRangeChange,
}: WidgetCommonProps) {
  const api = useCostApi();
  const focus = useCostFocus();
  const dispatch = useCostFocusDispatch();
  const [groupByOverride, setGroupByOverride] = useState<DimensionId | undefined>(undefined);
  const specGroupBy = spec.type === 'stackedBar' ? spec.groupBy : undefined;
  const effectiveGroupBy = groupByOverride ?? specGroupBy;
  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const origin = `widget:stackedBar:${String(effectiveGroupBy ?? '')}`;
  const { query, activeGroupBy, dailyResult } = useDailyWidgetQuery({
    specGroupBy: effectiveGroupBy,
    dateRange,
    granularity,
    globalFilters,
    specFilters: spec.filters,
    origin,
  });

  const prevQuery = useQuery<DailyCostsResult | null>(
    () => compareEnabled && effectiveGroupBy !== undefined
      ? api.queryDailyCosts({ groupBy: effectiveGroupBy, dateRange: previousDateRange, filters, granularity, origin: `${origin}/prev` })
      : Promise.resolve(null),
    [compareEnabled, effectiveGroupBy, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, fk, granularity, api, origin],
  );

  const barDays = useMemo(
    () => {
      const raw = dailyToBarDays(dailyResult);
      const filled = granularity === 'daily' ? fillDateRange(raw, dateRange.start, dateRange.end) : raw;
      return bucketBars(filled, MAX_BARS);
    },
    [dailyResult, granularity, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour],
  );

  const prevHasCoverage = prevQuery.status === 'success' && prevQuery.data !== null && hasSufficientDailyCoverage(prevQuery.data, previousDateRange);
  const previousTotals = useMemo(
    () => {
      const raw = dailyToTotals(prevHasCoverage ? prevQuery.data : null);
      if (raw.length <= MAX_BARS) return raw;
      const size = Math.ceil(raw.length / MAX_BARS);
      const bucketed: number[] = [];
      for (let i = 0; i < raw.length; i += size) {
        let sum = 0;
        for (let j = i; j < Math.min(i + size, raw.length); j++) sum += raw[j] ?? 0;
        bucketed.push(sum);
      }
      return bucketed;
    },
    [prevHasCoverage, prevQuery],
  );

  const handleRangeSelect = useCallback((startIdx: number, endIdx: number) => {
    if (onDateRangeChange === undefined) return;
    if (granularity === 'hourly') {
      const fallbackEndHour = `${String(dateRange.end)} 23:00:00`;
      const hourRange = computeBucketedHourRange(barDays, startIdx, endIdx, fallbackEndHour);
      if (hourRange === null) return;
      onDateRangeChange({
        start: asDateString(hourRange.startHour.slice(0, 10)),
        end: asDateString(hourRange.endHour.slice(0, 10)),
        startHour: asHourString(hourRange.startHour),
        endHour: asHourString(hourRange.endHour),
      });
      return;
    }
    const range = computeBucketedRange(barDays, startIdx, endIdx, dateRange.end);
    if (range === null) return;
    onDateRangeChange({
      start: asDateString(range.startDate),
      end: asDateString(range.endDate),
    });
  }, [barDays, dateRange.end, granularity, onDateRangeChange]);

  if (spec.type !== 'stackedBar') return null;

  const loading = query.status === 'loading';

  const defaultTitle = granularity === 'hourly' ? 'Hourly Costs' : 'Daily Costs';
  let title: React.ReactNode = spec.title ?? defaultTitle;
  if (spec.title === undefined && activeGroupBy !== undefined) {
    const label = dimensionLabelFor(dimensions, activeGroupBy);
    title = <GroupByTitle dimensions={dimensions} currentGroupBy={activeGroupBy} onGroupByChange={setGroupByOverride} label={label} />;
  }

  // Cross-chart focus is dimension-scoped: only honour an external hover when
  // it came from a chart grouped by the same dimension as us. Otherwise the
  // histogram would dim every bar when the user hovered, say, a Team slice.
  const externalHighlight = activeGroupBy !== undefined && focus.hoveredDimension === activeGroupBy
    ? focus.hoveredEntity
    : null;

  return (
    <StackedBarChart
      days={loading ? [] : barDays}
      highlightedGroup={externalHighlight}
      title={title}
      loading={loading}
      onSegmentClick={activeGroupBy === undefined ? undefined : (name) => { onSetFilter(activeGroupBy, asTagValue(name)); }}
      previousTotals={compareEnabled ? previousTotals : undefined}
      onRangeSelect={onDateRangeChange === undefined ? undefined : handleRangeSelect}
      onSegmentHover={activeGroupBy === undefined ? undefined : (name) => {
        dispatch({ type: 'HOVER', entity: name, dimension: activeGroupBy });
      }}
    />
  );
}
