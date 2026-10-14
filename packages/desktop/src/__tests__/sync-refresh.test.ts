import { describe, expect, it } from 'vitest';
import { refreshAfterSync, type SyncRefreshHooks } from '../main/handlers/sync-refresh.js';

/** Hooks that record the order they're called in; the rollup re-roll settles
 *  only when the test says so. */
function recordingHooks(): { hooks: SyncRefreshHooks; calls: string[]; finishRollup: () => void } {
  const calls: string[] = [];
  let finishRollup = (): void => { throw new Error('maintainRollup was not called'); };
  const hooks: SyncRefreshHooks = {
    maintainRollup: (months) => {
      calls.push(`maintainRollup:${months.join(',')}`);
      return new Promise<void>((resolve) => {
        finishRollup = () => { calls.push('rollup settled'); resolve(); };
      });
    },
    warmupBase: () => { calls.push('warmupBase'); },
    recomputeBaselines: () => { calls.push('recomputeBaselines'); },
  };
  return { hooks, calls, finishRollup: () => { finishRollup(); } };
}

/** Let every already-settled continuation run. */
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('refreshAfterSync', () => {
  it('recomputes baselines only once the first provider\'s re-rolled partitions have settled', async () => {
    const { hooks, calls, finishRollup } = recordingHooks();

    const done = refreshAfterSync(hooks, { tier: 'daily', firstProvider: true, changedMonths: ['2026-08', '2026-09'] });
    await flush();

    // Until the re-roll commits (and drops the result cache), a baseline query
    // would route to the pre-sync partition or hit a cached pre-sync result.
    expect(calls).toEqual(['maintainRollup:2026-08,2026-09']);

    finishRollup();
    await done;
    expect(calls).toEqual(['maintainRollup:2026-08,2026-09', 'rollup settled', 'recomputeBaselines']);
  });

  it('recomputes baselines right after refreshing caches for another provider\'s daily sync', async () => {
    const { hooks, calls } = recordingHooks();

    await refreshAfterSync(hooks, { tier: 'daily', firstProvider: false, changedMonths: ['2026-09'] });

    // Other providers are read raw; warmupBase drops the cached results synchronously.
    expect(calls).toEqual(['warmupBase', 'recomputeBaselines']);
  });

  it.each(['hourly', 'cost-optimization'] as const)('only refreshes caches after a %s sync', async (tier) => {
    const { hooks, calls } = recordingHooks();

    await refreshAfterSync(hooks, { tier, firstProvider: true, changedMonths: ['2026-09'] });

    expect(calls).toEqual(['warmupBase']);
  });
});
