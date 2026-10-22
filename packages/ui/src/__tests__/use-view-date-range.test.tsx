import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_COST_SCOPE, DEFAULT_LAG_DAYS, asDateString } from '@costgoblin/core/browser';
import type { CostScopeConfig } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { useViewDateRange } from '../hooks/use-view-date-range.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { daysAgo } from '../lib/dates.js';

// Pin Date so the range captured at mount and the one the assertions compute
// fall on the same day even across a UTC midnight.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-20T12:00:00Z'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const LAG = 7;

function renderWithScope(load: Promise<CostScopeConfig>, api = new MockCostApi()) {
  vi.spyOn(api, 'getCostScope').mockReturnValue(load);
  const wrapper = ({ children }: { children: ReactNode }) => <CostApiProvider value={api}>{children}</CostApiProvider>;
  return renderHook(() => useViewDateRange(), { wrapper });
}

function deferredScope(): { promise: Promise<CostScopeConfig>; release: (scope: CostScopeConfig) => void } {
  let release: (scope: CostScopeConfig) => void = () => undefined;
  const promise = new Promise<CostScopeConfig>(resolve => { release = resolve; });
  return { promise, release };
}

describe('useViewDateRange', () => {
  it('moves the default window to the cost scope lag once it loads', async () => {
    const scope = deferredScope();
    const { result } = renderWithScope(scope.promise);
    expect(result.current.dateRange).toEqual({ start: daysAgo(30 + DEFAULT_LAG_DAYS), end: daysAgo(DEFAULT_LAG_DAYS) });

    await act(async () => { scope.release({ ...DEFAULT_COST_SCOPE, lagDays: LAG }); await scope.promise; });

    expect(result.current.lagDays).toBe(LAG);
    expect(result.current.dateRange).toEqual({ start: daysAgo(30 + LAG), end: daysAgo(LAG) });
    expect(result.current.pickedRange).toBeNull();
  });

  it('keeps a range the view set before the lag loaded', async () => {
    const scope = deferredScope();
    const { result } = renderWithScope(scope.promise);
    const mine = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };
    act(() => { result.current.setDateRange(mine); });

    await act(async () => { scope.release({ ...DEFAULT_COST_SCOPE, lagDays: LAG }); await scope.promise; });

    expect(result.current.lagDays).toBe(LAG);
    expect(result.current.dateRange).toBe(mine);
    expect(result.current.pickedRange).toBe(mine);
  });

  it('keeps the same range object across renders while the lag is unchanged', async () => {
    const { result, rerender } = renderWithScope(Promise.resolve({ ...DEFAULT_COST_SCOPE, lagDays: LAG }));
    await waitFor(() => { expect(result.current.lagDays).toBe(LAG); });
    const first = result.current.dateRange;
    rerender();
    expect(result.current.dateRange).toBe(first);
  });

  it('starts a later mount on the lag the first one loaded', async () => {
    const api = new MockCostApi();
    const first = renderWithScope(Promise.resolve({ ...DEFAULT_COST_SCOPE, lagDays: LAG }), api);
    await waitFor(() => { expect(first.result.current.lagDays).toBe(LAG); });
    first.unmount();

    // The second mount's own load never answers: only the remembered lag can
    // put its window on 7 days.
    const { result } = renderWithScope(deferredScope().promise, api);
    expect(result.current.dateRange).toEqual({ start: daysAgo(30 + LAG), end: daysAgo(LAG) });
  });

  it('stays on the default lag when the cost scope fails to load', async () => {
    const load = Promise.reject(new Error('cost-scope.yaml: bad YAML'));
    const { result } = renderWithScope(load);
    // Let the rejection reach the hook's handler before asserting nothing moved.
    await act(async () => { await load.catch(() => undefined); await Promise.resolve(); });
    expect(result.current.lagDays).toBe(DEFAULT_LAG_DAYS);
    expect(result.current.dateRange).toEqual({ start: daysAgo(30 + DEFAULT_LAG_DAYS), end: daysAgo(DEFAULT_LAG_DAYS) });
  });
});
