import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePaginatedQuery, type PaginatedResult } from './use-paginated-query.js';

describe('usePaginatedQuery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('starts in loading state', () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockImplementation(() => new Promise(() => {})); // Never resolves
    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    expect(result.current.status).toBe('loading');
    expect(result.current.data).toEqual([]);
    expect(result.current.hasMore).toBe(false);
  });

  it('loads first page on mount', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockResolvedValue({
        data: ['item1', 'item2', 'item3'],
        cursor: 'cursor1',
        hasMore: true,
      });

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    // Initially loading
    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });

    // Then success
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    if (result.current.status === 'success') {
      expect(result.current.data).toEqual(['item1', 'item2', 'item3']);
      expect(result.current.hasMore).toBe(true);
      expect(result.current.loadMore).toBeDefined();
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(undefined);
  });

  it('loads next page when loadMore is called', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>();

    fetcher
      .mockResolvedValueOnce({
        data: ['item1', 'item2'],
        cursor: 'cursor1',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        data: ['item3', 'item4'],
        cursor: 'cursor2',
        hasMore: true,
      });

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    // Wait for first page
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.data).toEqual(['item1', 'item2']);

    // Load more
    if (result.current.status === 'success') {
      result.current.loadMore();
    }

    // Wait for second page
    await waitFor(() => {
      expect(result.current.data).toEqual(['item1', 'item2', 'item3', 'item4']);
    });

    expect(result.current.status).toBe('success');
    expect(result.current.hasMore).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, undefined);
    expect(fetcher).toHaveBeenNthCalledWith(2, 'cursor1');
  });

  it('accumulates data across multiple pages', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<number>>>();

    fetcher
      .mockResolvedValueOnce({
        data: [1, 2],
        cursor: 'c1',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        data: [3, 4],
        cursor: 'c2',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        data: [5],
        cursor: undefined,
        hasMore: false,
      });

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    // Page 1
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data).toEqual([1, 2]);

    // Page 2
    if (result.current.status === 'success') {
      result.current.loadMore();
    }
    await waitFor(() => {
      expect(result.current.data).toEqual([1, 2, 3, 4]);
    });

    // Page 3
    if (result.current.status === 'success') {
      result.current.loadMore();
    }
    await waitFor(() => {
      expect(result.current.data).toEqual([1, 2, 3, 4, 5]);
    });

    expect(result.current.status).toBe('success');
    expect(result.current.hasMore).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('handles last page with hasMore=false', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockResolvedValue({
        data: ['final'],
        cursor: undefined,
        hasMore: false,
      });

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.data).toEqual(['final']);
    expect(result.current.hasMore).toBe(false);
    if (result.current.status === 'success') {
      expect(result.current.loadMore).toBeDefined();
    }
  });

  it('handles errors and preserves current data', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>();

    fetcher
      .mockResolvedValueOnce({
        data: ['item1', 'item2'],
        cursor: 'cursor1',
        hasMore: true,
      })
      .mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    // First page succeeds
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data).toEqual(['item1', 'item2']);

    // Load more triggers error
    if (result.current.status === 'success') {
      result.current.loadMore();
    }

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    if (result.current.status === 'error') {
      expect(result.current.error.message).toBe('Network error');
      expect(result.current.data).toEqual(['item1', 'item2']); // Data preserved
      expect(result.current.hasMore).toBe(true); // hasMore preserved
    }
  });

  it('handles errors on first page', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockRejectedValue(new Error('Initial load failed'));

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    if (result.current.status === 'error') {
      expect(result.current.error.message).toBe('Initial load failed');
      expect(result.current.data).toEqual([]);
      expect(result.current.hasMore).toBe(false);
    }
  });

  it('retries on cancellation errors', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>();

    fetcher
      .mockRejectedValueOnce(new Error('Query cancelled'))
      .mockResolvedValueOnce({
        data: ['item1'],
        cursor: undefined,
        hasMore: false,
      });

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    // Should retry after cancellation
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    }, { timeout: 3000 });

    expect(result.current.data).toEqual(['item1']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_CANCEL_RETRIES', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockRejectedValue(new Error('Query cancelled'));

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    // Should eventually error after retries
    await waitFor(() => {
      expect(result.current.status).toBe('error');
    }, { timeout: 3000 });

    if (result.current.status === 'error') {
      expect(result.current.error.message).toBe('Query cancelled');
    }
    expect(fetcher.mock.calls.length).toBeGreaterThan(1);
  });

  it('resets state when dependencies change', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>();

    fetcher
      .mockResolvedValueOnce({
        data: ['old1', 'old2'],
        cursor: 'cursor1',
        hasMore: true,
      })
      .mockResolvedValueOnce({
        data: ['new1', 'new2'],
        cursor: 'cursor2',
        hasMore: false,
      });

    const { result, rerender } = renderHook(
      ({ dep }) => usePaginatedQuery(fetcher, [dep]),
      { initialProps: { dep: 'filter1' } },
    );

    // Wait for first load
    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });
    expect(result.current.data).toEqual(['old1', 'old2']);

    // Change dependency
    rerender({ dep: 'filter2' });

    // Should reset and reload
    await waitFor(() => {
      expect(result.current.data).toEqual(['new1', 'new2']);
    });

    expect(result.current.status).toBe('success');
    expect(result.current.hasMore).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('prevents concurrent loads', async () => {
    let resolveFirstLoad: ((value: PaginatedResult<string>) => void) | undefined;
    const firstLoadPromise = new Promise<PaginatedResult<string>>((resolve) => {
      resolveFirstLoad = resolve;
    });

    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockReturnValueOnce(firstLoadPromise)
      .mockResolvedValue({
        data: ['should-not-load'],
        cursor: undefined,
        hasMore: false,
      });

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe('loading');
    });

    // Try to load more while still loading
    if (result.current.status !== 'success') {
      // loadMore doesn't exist on non-success states, which is correct
      // The hook should be in loading state
      expect(result.current.status).toBe('loading');
    }

    // Complete the first load
    resolveFirstLoad?.({
      data: ['item1'],
      cursor: 'cursor1',
      hasMore: true,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    expect(result.current.data).toEqual(['item1']);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('handles non-Error exceptions', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockRejectedValue('string error');

    const { result } = renderHook(() => usePaginatedQuery(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });

    if (result.current.status === 'error') {
      expect(result.current.error.message).toBe('string error');
      expect(result.current.error).toBeInstanceOf(Error);
    }
  });

  it('maintains stable loadMore reference between renders', async () => {
    const fetcher = vi.fn<(cursor?: string) => Promise<PaginatedResult<string>>>()
      .mockResolvedValue({
        data: ['item1'],
        cursor: 'cursor1',
        hasMore: true,
      });

    const { result, rerender } = renderHook(() => usePaginatedQuery(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe('success');
    });

    const firstLoadMore = result.current.status === 'success' ? result.current.loadMore : undefined;

    // Force a re-render
    rerender();

    expect(result.current.status).toBe('success');
    const secondLoadMore = result.current.status === 'success' ? result.current.loadMore : undefined;

    // loadMore should be a stable reference
    expect(firstLoadMore).toBe(secondLoadMore);
  });
});
