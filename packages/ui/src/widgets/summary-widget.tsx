import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { SummaryCard } from '../components/summary-card.js';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostResult } from '@costgoblin/core/browser';
import type { WidgetCommonProps } from './widget.js';
import { filtersKey, mergeFilters } from './widget.js';

export function SummaryWidget({
  dateRange,
  previousDateRange,
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
    () => isSummary ? api.queryCosts({ groupBy, dateRange: previousDateRange, filters, granularity }) : Promise.resolve(null),
    [isSummary, groupBy, previousDateRange.start, previousDateRange.end, fk, granularity, api],
  );

  if (!isSummary) return null;

  // `null` means "still loading / errored" — SummaryCard renders a dash
  // placeholder rather than briefly showing $0.00.
  const totalCost = cur.status === 'success' && cur.data !== null ? cur.data.totalCost : null;
  const previousCost = prev.status === 'success' && prev.data !== null ? prev.data.totalCost : null;

  return (
    <SummaryCard totalCost={totalCost} previousCost={previousCost} dateRange={dateRange} />
  );
}
