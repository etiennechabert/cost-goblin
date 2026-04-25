import { useMemo } from 'react';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { BubbleChart } from '../components/bubble-chart.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { asDollars } from '@costgoblin/core/browser';
import type { TrendResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';

const DEFAULT_DELTA_THRESHOLD = asDollars(50);
const DEFAULT_PERCENT_THRESHOLD = 5;

function combinedRows(data: TrendResult | null): TrendResult['increases'] {
  if (data === null) return [];
  return [...data.increases, ...data.savings];
}

export function BubbleWidget({
  spec,
  dateRange,
  globalFilters,
  onEntityClick,
}: WidgetCommonProps) {
  const api = useCostApi();
  if (spec.type !== 'bubble') return null;
  const specGroupBy = spec.groupBy;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery(
    () => api.queryTrends({
      groupBy: specGroupBy,
      dateRange,
      filters,
      deltaThreshold: DEFAULT_DELTA_THRESHOLD,
      percentThreshold: DEFAULT_PERCENT_THRESHOLD,
    }),
    [specGroupBy, dateRange.start, dateRange.end, fk, api],
  );

  const data = useMemo(
    () => combinedRows(query.status === 'success' ? query.data : null),
    [query],
  );

  if (query.status === 'loading') return <CoinRainLoader height={260} count={5} />;

  return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      {spec.title !== undefined && (
        <h3 className="text-sm font-medium text-text-secondary mb-2">{spec.title}</h3>
      )}
      <BubbleChart
        data={data}
        onEntityClick={(entity) => { onEntityClick?.(entity, specGroupBy); }}
      />
    </div>
  );
}
