import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { HeatmapChart } from '../components/heatmap-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import type { HeatmapCell } from '../components/heatmap-chart.js';
import { asTagValue } from '@costgoblin/core/browser';
import type { DailyCostsResult, DimensionId } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { dimensionLabelFor, filtersKey, getDimensionFallback, mergeFilters } from './widget.js';

interface DailyQueryResult {
  readonly result: DailyCostsResult;
  readonly groupBy: DimensionId;
}

interface BuiltCells {
  readonly cells: readonly HeatmapCell[];
  readonly groups: readonly string[];
  readonly dates: readonly string[];
}

function buildCells(data: DailyCostsResult | null, topN: number): BuiltCells {
  if (data === null) return { cells: [], groups: [], dates: [] };
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
  const cells: HeatmapCell[] = [];
  for (const day of data.days) {
    for (const g of top) {
      cells.push({ date: day.date, group: g, cost: day.breakdown[g] ?? 0 });
    }
  }
  return {
    cells,
    groups: top,
    dates: data.days.map(d => d.date),
  };
}

export function HeatmapWidget({
  spec,
  dateRange,
  granularity,
  globalFilters,
  dimensions,
  onSetFilter,
}: WidgetCommonProps) {
  const api = useCostApi();
  if (spec.type !== 'heatmap') return null;
  const specGroupBy = spec.groupBy;
  const topN = spec.topN ?? 12;

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
  const { cells, groups, dates } = useMemo(
    () => buildCells(query.status === 'success' ? query.data.result : null, topN),
    [query, topN],
  );

  const label = dimensionLabelFor(dimensions, activeGroupBy);

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <HeatmapChart
      cells={cells}
      groups={groups}
      dates={dates}
      title={spec.title ?? `${label} × Day`}
      subtitle="Click a cell to filter"
      onCellClick={(group) => { onSetFilter(activeGroupBy, asTagValue(group)); }}
    />
  );
}
