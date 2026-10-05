import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CostApi, CostScopeConfig } from '@costgoblin/core/browser';
import { DEFAULT_COST_SCOPE, DEFAULT_LAG_DAYS } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { useLagDays } from '../hooks/use-lag-days.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';

/** Every getCostScope call gets its own promise, settled by the test — so a
 *  test controls when, and in what order, each read lands. */
class DeferredScopeApi extends MockCostApi {
  readonly reads: { resolve: (scope: CostScopeConfig) => void; reject: (err: Error) => void }[] = [];
  override getCostScope(): Promise<CostScopeConfig> {
    return new Promise((resolve, reject) => { this.reads.push({ resolve, reject }); });
  }
}

function scopeWithLag(lagDays: number): CostScopeConfig {
  return { ...DEFAULT_COST_SCOPE, lagDays };
}

function renderLag(api: CostApi, options?: { strict?: boolean }) {
  return renderHook(() => useLagDays(), {
    wrapper: ({ children }: { children: ReactNode }) => <CostApiProvider value={api}>{children}</CostApiProvider>,
    // Root-level: React replays a fresh mount's effects only when the mounted
    // tree's root sits inside StrictMode, and one within `wrapper` is below it.
    reactStrictMode: options?.strict === true,
  });
}

/** Settle a read inside act, so the hook's `.then` has run (and any update it
 *  made has rendered) before the test asserts. */
async function settle(settleRead: () => void): Promise<void> {
  await act(async () => {
    settleRead();
    await Promise.resolve();
  });
}

describe('useLagDays', () => {
  it('reports the default, not loaded, until the configured lag arrives', async () => {
    const api = new DeferredScopeApi();
    const { result } = renderLag(api);
    expect(result.current).toEqual({ loaded: false, lagDays: DEFAULT_LAG_DAYS });

    await settle(() => { api.reads[0]?.resolve(scopeWithLag(5)); });
    expect(result.current).toEqual({ loaded: true, lagDays: 5 });
  });

  it('loads the default when the cost scope sets no lag', async () => {
    const api = new DeferredScopeApi();
    const { result } = renderLag(api);
    await settle(() => { api.reads[0]?.resolve(DEFAULT_COST_SCOPE); });
    expect(result.current).toEqual({ loaded: true, lagDays: DEFAULT_LAG_DAYS });
  });

  it('keeps the default in force, never loaded, when the read fails', async () => {
    const api = new DeferredScopeApi();
    const { result } = renderLag(api);
    await settle(() => { api.reads[0]?.reject(new Error('cost scope unreadable')); });
    expect(result.current).toEqual({ loaded: false, lagDays: DEFAULT_LAG_DAYS });
  });

  it('drops a read that lands after its effect was cleaned up (StrictMode remount)', async () => {
    // StrictMode mounts, unmounts and remounts the effect: two reads, the
    // first one already cleaned up. Settle the live read first, then the
    // dead one, which must not overwrite it.
    const api = new DeferredScopeApi();
    const { result } = renderLag(api, { strict: true });
    expect(api.reads).toHaveLength(2);

    await settle(() => { api.reads[1]?.resolve(scopeWithLag(5)); });
    await settle(() => { api.reads[0]?.resolve(scopeWithLag(9)); });
    expect(result.current).toEqual({ loaded: true, lagDays: 5 });
  });
});
