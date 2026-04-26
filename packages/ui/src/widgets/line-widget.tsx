import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { LineChart } from '../components/line-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { LineSeries } from '../components/line-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DailyCostsResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, getDimensionFallback, mergeFilters } from './widget.js';

interface DailyQueryResult {
  readonly result: DailyCostsResult;
  readonly groupBy: DimensionId;
}

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
  const api = useCostApi();
  if (spec.type !== 'line') return null;
  const specGroupBy = spec.groupBy;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery<DailyQueryResult>(
    async () => {
      const primary = await api.queryDailyCosts({ groupBy: specGroupBy, dateRange, filters, granularity });
      const fallbackDim = getDimensionFallback(specGroupBy);
      if (primary.groups.length <= 1 && fallbackDim !== undefined) {
        const fallback = await api.queryDailyCosts({ groupBy: fallbackDim, dateRange, filters, granularity });
        return { result: fallback, groupBy: fallbackDim };
      }
      return { result: primary, groupBy: specGroupBy };
    },
    [specGroupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );

  const activeGroupBy = query.status === 'success' ? query.data.groupBy : specGroupBy;
  const topN = spec.topN ?? 6;
  const series = useMemo(
    () => buildSeries(query.status === 'success' ? query.data.result : null, topN),
    [query, topN],
  );

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
