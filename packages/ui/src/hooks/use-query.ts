import { startTransition, useEffect, useRef, useState } from 'react';
import { QUERY_CANCELLED_MESSAGE, type QueryState } from '@costgoblin/core/browser';
import { useWidgetSlot } from './widget-load-scheduler.js';

const MAX_CANCEL_RETRIES = 2;

function handleFetchSuccess<T>(
  data: T,
  cancelled: { current: boolean },
  setState: (s: QueryState<T>) => void,
): void {
  // Apply the result inside a transition so the (potentially heavy) render it
  // triggers — visx charts, large tables — stays interruptible. When a view
  // mounts many widgets, their results arrive in a burst; without this, React
  // renders each one as an urgent, blocking commit and the renderer's main
  // thread can't service input, so the top menu appears frozen until the burst
  // drains. As a transition, React time-slices the work and lets a click (e.g.
  // opening the menu) preempt it. The `loading` state stays urgent so spinners
  // still appear instantly.
  startTransition(() => {
    if (!cancelled.current) setState({ status: 'success', data });
  });
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
  if (msg === QUERY_CANCELLED_MESSAGE && retryCount < MAX_CANCEL_RETRIES) {
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

  // Report completion to the surrounding dashboard widget slot (if any) so the
  // load scheduler can free a concurrency slot for the next widget. Null
  // outside a LazyWidgetSlot, so this is a no-op for non-widget queries.
  const slot = useWidgetSlot();
  const slotRef = useRef(slot);
  slotRef.current = slot;

  // Release only once the settled state has COMMITTED, not when the promise
  // settles. Results are applied in a transition, transitions render as one
  // batch, and the scheduler mounting the next widget is an urgent update that
  // restarts that batch. Releasing on promise settle therefore mounted the next
  // wave before this widget's result painted, and its data only appeared once
  // every widget on the page had loaded and rendered together (seconds under
  // load). Releasing after commit shows each wave's results before the next
  // wave starts. A widget that never settles is still released by the
  // slot's fallback timer.
  useEffect(() => {
    if (state.status === 'success' || state.status === 'error') slotRef.current?.onSettled();
  }, [state]);

  useEffect(() => {
    const cancelled = { current: false };

    setState({ status: 'loading' });

    const delay = retryCount > 0 ? 150 : 0;
    const timer = setTimeout(() => {
      fetcher()
        .then((data) => { handleFetchSuccess(data, cancelled, setState); })
        .catch((err: unknown) => { handleFetchError(err, cancelled, retryCount, setState, setRetryCount); });
    }, delay);

    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
  }, [...deps, retryCount]);

  return state;
}
