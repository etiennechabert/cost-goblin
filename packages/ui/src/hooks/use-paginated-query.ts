import { useCallback, useEffect, useRef, useState } from 'react';

/** Result shape for paginated queries - matches ExplorerRowsResult pattern */
export interface PaginatedResult<T> {
  readonly data: readonly T[];
  readonly cursor?: string | undefined;
  readonly hasMore: boolean;
}

/** Paginated query state returned by the hook */
export type PaginatedQueryState<T> =
  | { readonly status: 'idle'; readonly data: readonly T[]; readonly hasMore: boolean }
  | { readonly status: 'loading'; readonly data: readonly T[]; readonly hasMore: boolean }
  | { readonly status: 'success'; readonly data: readonly T[]; readonly hasMore: boolean; readonly loadMore: () => void }
  | { readonly status: 'error'; readonly error: Error; readonly data: readonly T[]; readonly hasMore: boolean };

const MAX_CANCEL_RETRIES = 2;

interface InternalState<T> {
  readonly accumulatedData: readonly T[];
  readonly cursor: string | undefined;
  readonly hasMore: boolean;
}

/**
 * Hook for paginated queries with cursor-based pagination.
 * Accumulates data across pages and provides a loadMore function.
 *
 * @param fetcher - Async function that takes an optional cursor and returns paginated results
 * @param deps - Dependency array that triggers a reset when changed
 * @returns Paginated query state with accumulated data and loadMore function
 *
 * @example
 * ```tsx
 * const state = usePaginatedQuery(
 *   (cursor) => api.queryExplorerRows({ ...params, cursor }),
 *   [filters, dateRange]
 * );
 *
 * if (state.status === 'success') {
 *   return (
 *     <>
 *       <Table data={state.data} />
 *       {state.hasMore && <Button onClick={state.loadMore}>Load More</Button>}
 *     </>
 *   );
 * }
 * ```
 */
export function usePaginatedQuery<T>(
  fetcher: (cursor?: string) => Promise<PaginatedResult<T>>,
  deps: unknown[],
): PaginatedQueryState<T> {
  const [state, setState] = useState<PaginatedQueryState<T>>({
    status: 'idle',
    data: [],
    hasMore: false,
  });
  const [retryCount, setRetryCount] = useState(0);
  const [loadTrigger, setLoadTrigger] = useState(0);

  const internalRef = useRef<InternalState<T>>({
    accumulatedData: [],
    cursor: undefined,
    hasMore: false,
  });

  const loadMoreRef = useRef<() => void>(() => {});

  const loadMore = useCallback(() => {
    setLoadTrigger(t => t + 1);
  }, []);

  loadMoreRef.current = loadMore;

  useEffect(() => {
    // Reset on deps change
    internalRef.current = {
      accumulatedData: [],
      cursor: undefined,
      hasMore: false,
    };
    setState({ status: 'idle', data: [], hasMore: false });
    setRetryCount(0);
    setLoadTrigger(0);
  }, deps);

  useEffect(() => {
    const cancelled = { current: false };

    setState(prev => ({
      ...prev,
      status: 'loading',
    }));

    const delay = retryCount > 0 ? 150 : 0;
    const timer = setTimeout(() => {
      // Read fresh values from ref at fetch time
      const { accumulatedData, cursor } = internalRef.current;

      fetcher(cursor)
        .then((result) => {
          if (cancelled.current) return;

          const newData = [...accumulatedData, ...result.data];
          internalRef.current = {
            accumulatedData: newData,
            cursor: result.cursor,
            hasMore: result.hasMore,
          };

          setState({
            status: 'success',
            data: newData,
            hasMore: result.hasMore,
            loadMore: loadMoreRef.current,
          });
        })
        .catch((err: unknown) => {
          if (cancelled.current) return;

          const msg = err instanceof Error ? err.message : String(err);
          if (msg === 'Query cancelled' && retryCount < MAX_CANCEL_RETRIES) {
            setRetryCount(c => c + 1);
            return;
          }

          const { accumulatedData, hasMore } = internalRef.current;
          setState({
            status: 'error',
            error: err instanceof Error ? err : new Error(msg),
            data: accumulatedData,
            hasMore,
          });
        });
    }, delay);

    return () => {
      cancelled.current = true;
      clearTimeout(timer);
    };
  }, [...deps, retryCount, loadTrigger]);

  return state;
}
