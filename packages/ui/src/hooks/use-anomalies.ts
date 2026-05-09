import { useEffect, useState } from 'react';
import type { AnomalyDetectionParams, AnomalyResult, QueryState } from '@costgoblin/core/browser';
import { useCostApi } from './use-cost-api.js';

const MAX_CANCEL_RETRIES = 2;

function handleFetchSuccess(
  data: AnomalyResult,
  cancelled: { current: boolean },
  setState: (s: QueryState<AnomalyResult>) => void,
): void {
  if (!cancelled.current) setState({ status: 'success', data });
}

function handleFetchError(
  err: unknown,
  cancelled: { current: boolean },
  retryCount: number,
  setState: (s: QueryState<AnomalyResult>) => void,
  setRetryCount: (fn: (c: number) => number) => void,
): void {
  if (cancelled.current) return;
  const msg = err instanceof Error ? err.message : String(err);
  if (msg === 'Query cancelled' && retryCount < MAX_CANCEL_RETRIES) {
    setRetryCount(c => c + 1);
    return;
  }
  setState({
    status: 'error',
    error: err instanceof Error ? err : new Error(msg),
  });
}

export function useAnomalies(
  params: AnomalyDetectionParams,
): QueryState<AnomalyResult> {
  const api = useCostApi();
  const [state, setState] = useState<QueryState<AnomalyResult>>({ status: 'idle' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const cancelled = { current: false };

    setState({ status: 'loading' });

    const delay = retryCount > 0 ? 150 : 0;
    const timer = setTimeout(() => {
      api.queryAnomalies(params)
        .then((data) => { handleFetchSuccess(data, cancelled, setState); })
        .catch((err: unknown) => { handleFetchError(err, cancelled, retryCount, setState, setRetryCount); });
    }, delay);

    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
  }, [api, params.dateRange, params.filters, params.groupBy, params.lookbackDays, params.stddevThreshold, retryCount]);

  return state;
}
