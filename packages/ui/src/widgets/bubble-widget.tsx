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
  const specGroupBy = spec.type === 'bubble' ? spec.groupBy : undefined;

  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);
  const query = useQuery(
    () => specGroupBy === undefined
      ? Promise.resolve(null)
      : api.queryTrends({
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

  if (spec.type !== 'bubble' || specGroupBy === undefined) return null;
  if (query.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary/50 px-4 py-4">
      <CoinRainLoader height={260} count={5} />
    </div>
  );

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
