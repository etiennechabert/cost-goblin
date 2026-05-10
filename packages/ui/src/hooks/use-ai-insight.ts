import { useMemo } from 'react';
import { useCostApi } from './use-cost-api.js';
import { useQuery } from './use-query.js';
import type {
  AIInsight,
  InsightParams,
  QueryState,
} from '@costgoblin/core/browser';
import { filtersKey } from '../widgets/widget.js';

interface AIInsightResult {
  readonly query: QueryState<AIInsight>;
}

/**
 * Custom hook for generating AI insights. Wraps the async `generateInsight`
 * API call in a `useQuery` state machine.
 *
 * Dependencies are extracted from the params discriminated union to ensure
 * re-generation when inputs change:
 *   - TrendSummaryParams: type, dateRange, filters, groupBy
 *   - OptimizationParams: type, dateRange, filters, minCost
 *   - ConversationalParams: type, query, dateRange (optional), filters (optional)
 *
 * Returns a QueryState discriminated union: idle | loading | success | error.
 *
 * @example
 * ```tsx
 * const { query } = useAIInsight({
 *   type: 'trend-summary',
 *   dateRange: { start: '2024-01-01', end: '2024-01-31' },
 *   filters: {},
 *   groupBy: 'service' as DimensionId,
 * });
 *
 * if (query.status === 'success') {
 *   console.log(query.data.result);
 * }
 * ```
 */
export function useAIInsight(params: InsightParams): AIInsightResult {
  const api = useCostApi();

  const deps = useMemo(() => {
    switch (params.type) {
      case 'trend-summary':
        return [
          params.type,
          params.dateRange.start,
          params.dateRange.end,
          params.dateRange.startHour,
          params.dateRange.endHour,
          filtersKey(params.filters),
          params.groupBy,
        ];
      case 'optimization':
        return [
          params.type,
          params.dateRange.start,
          params.dateRange.end,
          params.dateRange.startHour,
          params.dateRange.endHour,
          filtersKey(params.filters),
          params.minCost,
        ];
      case 'conversational':
        return [
          params.type,
          params.query,
          params.dateRange?.start,
          params.dateRange?.end,
          params.dateRange?.startHour,
          params.dateRange?.endHour,
          filtersKey(params.filters ?? {}),
        ];
    }
  }, [params]);

  const query = useQuery<AIInsight>(
    () => api.generateInsight(params),
    [...deps, api],
  );

  return { query };
}
