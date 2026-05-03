import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

import { SummaryCard } from '../components/summary-card.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters, hasSufficientCoverage } from './widget.js';

export function SummaryWidget({
  dateRange,
  previousDateRange,
  compareEnabled,
  granularity,
  globalFilters,
  spec,
}: WidgetCommonProps) {
  const api = useCostApi();
  const isSummary = spec.type === 'summary';

  const groupBy = asDimensionId('account');
  const filters = mergeFilters(globalFilters, spec.filters);
  const fk = filtersKey(filters);

  const cur = useQuery<CostResult | null>(
    () => isSummary ? api.queryCosts({ groupBy, dateRange, filters, granularity }) : Promise.resolve(null),
    [isSummary, groupBy, dateRange.start, dateRange.end, fk, granularity, api],
  );
  const prev = useQuery<CostResult | null>(
    () => isSummary && compareEnabled ? api.queryCosts({ groupBy, dateRange: previousDateRange, filters, granularity }) : Promise.resolve(null),
    [isSummary, compareEnabled, groupBy, previousDateRange.start, previousDateRange.end, fk, granularity, api],
  );

  if (!isSummary) return null;

  if (cur.status === 'loading') return (
    <div className="rounded-xl border border-border bg-bg-secondary px-6 py-5 h-full">
      <CoinRainLoader height={200} count={4} />
    </div>
  );

  const totalCost = cur.status === 'success' && cur.data !== null ? cur.data.totalCost : null;

  const prevData = prev.status === 'success' ? prev.data : null;
  const previousComplete = prevData !== null && hasSufficientCoverage(prevData, previousDateRange);
  const previousCost = previousComplete ? prevData.totalCost : null;

  return (
    <SummaryCard totalCost={totalCost} previousCost={previousCost} dateRange={dateRange} previousDateRange={previousComplete ? previousDateRange : undefined} />
  );
}
