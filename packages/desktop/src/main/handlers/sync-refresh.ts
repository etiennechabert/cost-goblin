import type { SyncTier } from '../sync-id.js';
import type { AppContext } from './context.js';

/** The AppContext hooks a post-sync refresh drives. */
export type SyncRefreshHooks = Pick<AppContext, 'maintainRollup' | 'warmupBase' | 'recomputeBaselines'>;

/** Bring derived state in step with the raw files a sync just replaced.
 *
 *  Daily data of the FIRST provider feeds the rollup (the RollupStore is bound
 *  to its tree), so only its changed partitions are re-rolled; other providers'
 *  daily data is queried raw, and hourly / cost-opt feed neither the rollup nor
 *  baselines — dropping cached results is enough for those.
 *
 *  Baselines read ALL providers, so every daily sync recomputes them — but only
 *  once the re-roll has settled. Until its partitions commit and the result
 *  cache is dropped, a baseline query routes to the pre-sync partition (a
 *  forced rebuild keeps it valid until its commit) or is answered from a
 *  cached pre-sync result, and nothing would recompute again afterwards. */
export async function refreshAfterSync(
  app: SyncRefreshHooks,
  sync: { readonly tier: SyncTier; readonly firstProvider: boolean; readonly changedMonths: readonly string[] },
): Promise<void> {
  if (sync.tier !== 'daily') { app.warmupBase(); return; }
  if (sync.firstProvider) await app.maintainRollup(sync.changedMonths);
  else app.warmupBase();
  app.recomputeBaselines();
}
