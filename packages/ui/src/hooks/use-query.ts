import { useEffect, useState } from 'react';
import type { QueryState } from '@costgoblin/core/browser';

const MAX_CANCEL_RETRIES = 2;

export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ status: 'idle' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setState({ status: 'loading' });

    fetcher()
      .then((data) => {
        if (!cancelled) setState({ status: 'success', data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'Query cancelled' && retryCount < MAX_CANCEL_RETRIES) {
          setRetryCount(c => c + 1);
          return;
        }
        setState({
          status: 'error',
          error: err instanceof Error ? err : new Error(msg),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [...deps, retryCount]);

  return state;
}
