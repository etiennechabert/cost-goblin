import { startTransition, useEffect, useState } from 'react';
import type { QueryState } from '@costgoblin/core/browser';

const MAX_CANCEL_RETRIES = 2;

function handleFetchSuccess<T>(
  data: T,
  cancelled: { current: boolean },
  setState: (s: QueryState<T>) => void,
): void {
  if (!cancelled.current) setState({ status: 'success', data });
}

function handleFetchError<T>(
  err: unknown,
  cancelled: { current: boolean },
  retryCount: number,
  setState: (s: QueryState<T>) => void,
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

export function useQuery<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
): QueryState<T> {
  const [state, setState] = useState<QueryState<T>>({ status: 'idle' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    const cancelled = { current: false };

    setState({ status: 'loading' });

    const delay = retryCount > 0 ? 150 : 0;
    const timer = setTimeout(() => {
      fetcher()
        .then((data) => {
          // Apply the result inside a transition so the (potentially heavy)
          // render it triggers — visx charts, large tables — stays
          // interruptible. When a view mounts many widgets, their results
          // arrive in a burst; without this, React renders each one as an
          // urgent, blocking commit and the renderer's main thread can't
          // service input, so the top menu appears frozen until the burst
          // drains. As a transition, React time-slices the work and lets a
          // click (e.g. opening the menu) preempt it. The `loading` state
          // above stays urgent so spinners still appear instantly.
          startTransition(() => { handleFetchSuccess(data, cancelled, setState); });
        })
        .catch((err: unknown) => { handleFetchError(err, cancelled, retryCount, setState, setRetryCount); });
    }, delay);

    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
  }, [...deps, retryCount]);

  return state;
}
