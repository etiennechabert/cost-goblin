import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';

import { SummaryCard } from '../components/summary-card.js';
import { CoinRainLoader } from '../components/coin-rain-loader.js';
import { isPeriodGranularity } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, hasSufficientCoverage, TOTALS_GROUP_BY } from './widget.js';

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

  const groupBy = TOTALS_GROUP_BY;
  const fk = filtersKey(globalFilters);

  const cur = useQuery<CostResult | null>(
    () => isSummary ? api.queryCosts({ groupBy, dateRange, filters: globalFilters, granularity, origin: 'widget:summary:total' }) : Promise.resolve(null),
    [isSummary, groupBy, dateRange.start, dateRange.end, dateRange.startHour, dateRange.endHour, fk, granularity, api],
  );
  const prev = useQuery<CostResult | null>(
    () => isSummary && compareEnabled ? api.queryCosts({ groupBy, dateRange: previousDateRange, filters: globalFilters, granularity, origin: 'widget:summary:total/prev' }) : Promise.resolve(null),
    [isSummary, compareEnabled, groupBy, previousDateRange.start, previousDateRange.end, previousDateRange.startHour, previousDateRange.endHour, fk, granularity, api],
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

  // A Weekly/Monthly selection spans whole periods, so it reaches past the
  // newest day the handler reads (freshness lag): the daily average divides by
  // the range actually read. Daily and Hourly keep the selection's length.
  const periodMode = isPeriodGranularity(granularity);
  const coveredRange = periodMode && cur.status === 'success' && cur.data !== null ? cur.data.dateRange : undefined;
  const previousCoveredRange = periodMode && previousComplete ? prevData.dateRange : undefined;

  return (
    <SummaryCard
      totalCost={totalCost}
      previousCost={previousCost}
      dateRange={dateRange}
      previousDateRange={previousComplete ? previousDateRange : undefined}
      coveredRange={coveredRange}
      previousCoveredRange={previousCoveredRange}
    />
  );
}
