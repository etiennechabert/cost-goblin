import { ipcMain } from 'electron';
import { getDataInventory, getLocalDataInventory, extractPeriod, providerAuth, resolveBucketPath, writeTierLastSync } from '@costgoblin/core';
import type { AutoSyncStatus, ProviderConfig } from '@costgoblin/core';
import {
  startAutoSync,
  stopAutoSync,
  getAutoSyncStatus,
  readAutoSyncEnabled,
  writeAutoSyncEnabled,
  readAutoPruneEnabled,
  writeAutoPruneEnabled,
  readAutoSyncIntervalMinutes,
  writeAutoSyncIntervalMinutes,
} from '../auto-sync.js';
import { deleteLocalPeriodFiles, cascadeRollupForDeletedMonth, changedRollupMonths } from './sync.js';
import { resolveProvider, syncStatusKey } from '../sync-id.js';
import { type AppContext, isAnyCredentialError, prefsPath, toUserFriendlyError } from './context.js';
import { type SyncClient, SYNC_ALREADY_RUNNING } from '../sync-client.js';
import { recordSyncLog } from '../sync-log.js';

type Tier = 'daily' | 'hourly' | 'cost-optimization';

function asTier(s: string): Tier {
  if (s === 'hourly' || s === 'cost-optimization') return s;
  return 'daily';
}

function computeSyncFraction(bytesDone: number, bytesTotal: number, filesDone: number, filesTotal: number): number {
  if (bytesTotal > 0) return bytesDone / bytesTotal;
  if (filesTotal > 0) return filesDone / filesTotal;
  return 0;
}

// Resolve one provider's full config (credentials, buckets) by name — the
// scheduler passes only the name, so every call re-reads config and picks
// up edits between passes. An unknown name throws and surfaces as that
// provider's ProviderSyncError instead of silently syncing the wrong one.
async function providerByName(app: AppContext, providerName: string): Promise<ProviderConfig> {
  const config = await app.getConfig();
  return resolveProvider(config.providers, providerName);
}

// Rollup maintenance is bound to the FIRST provider (the single
// RollupStore rolls up its tree only); other providers' data is queried
// raw, so their changes must never re-roll it.
async function isFirstProvider(app: AppContext, provider: ProviderConfig): Promise<boolean> {
  const first = await app.getFirstProviderName();
  return first !== null && provider.name === first;
}

export function registerAutoSyncHandlers(app: AppContext): void {
  const { ctx, state, getConfig } = app;

  const autoSyncPrefsPath = () => prefsPath(ctx.stateDir, 'app-preferences');

  function buildAutoSyncDeps(syncClient: SyncClient) {
    return {
      onLog: recordSyncLog,
      getPrefsPath: autoSyncPrefsPath,
      getConfig: async () => {
        const config = await getConfig();
        return { providers: [...config.providers] };
      },
      getInventory: async (providerName: string, tier: string) => {
        const provider = await providerByName(app, providerName);
        const t = asTier(tier);
        const bucket = resolveBucketPath(provider, t);
        let inv;
        try {
          inv = await getDataInventory(bucket, providerAuth(provider), ctx.dataDir, provider.name, t);
        } catch (err: unknown) {
          // Rewrite credential failures into the actionable "run aws sso login"
          // message so the scheduler surfaces it (instead of silently skipping)
          // and the toolbar shows why background sync stopped.
          if (isAnyCredentialError(err)) throw toUserFriendlyError(err, providerAuth(provider));
          throw err;
        }
        return {
          periods: inv.periods.map(p => ({
            period: p.period,
            localStatus: p.localStatus,
            files: [...p.files],
          })),
        };
      },
      syncPeriods: async (providerName: string, files: { key: string; contentHash: string; size: number }[], tier: string) => {
        const provider = await providerByName(app, providerName);
        const t = asTier(tier);
        const bucket = resolveBucketPath(provider, t);

        const key = syncStatusKey(provider.name, t);
        // Never race a manual sync (or another scheduler pass) for the same
        // provider/tier: a concurrent start shares GCP staging/etag state and
        // can install a partial month stamped complete. Skip quietly and let
        // the in-flight sync deliver the data; the SyncClient enforces this
        // airtightly too, this just avoids overwriting the live status.
        if (state.syncStatuses[key]?.status === 'syncing') {
          return { filesDownloaded: 0, rowsProcessed: 0 };
        }
        state.syncStatuses[key] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: files.length, filesDone: 0, bytesTotal: 0, bytesDone: 0, message: '' };
        try {
          const result = await syncClient.syncPeriods({
            bucketPath: bucket,
            auth: providerAuth(provider),
            providerName: provider.name,
            dataDir: ctx.dataDir,
            tier: t,
            files,
            syncKey: key,
            onProgress: (progress) => {
              const bytesDone = progress.bytesDone ?? 0;
              const bytesTotal = progress.bytesTotal ?? 0;
              const fraction = computeSyncFraction(bytesDone, bytesTotal, progress.filesDone, progress.filesTotal);
              state.syncStatuses[key] = {
                status: 'syncing',
                phase: progress.phase === 'repartitioning' ? 'repartitioning' : 'downloading',
                progress: fraction,
                filesTotal: progress.filesTotal,
                filesDone: progress.filesDone,
                bytesTotal,
                bytesDone,
                message: progress.message ?? '',
              };
            },
          });
          const now = new Date();
          state.syncStatuses[key] = { status: 'completed', lastSync: now, filesDownloaded: result.filesDownloaded };
          // Best-effort: cosmetic timestamp; a write failure must not flip this
          // successful sync to 'failed' (the catch below would do exactly that).
          await writeTierLastSync(ctx.dataDir, provider.name, t, now.toISOString()).catch(() => { /* cosmetic */ });
          // Keep the rollup in step with the raw the auto-sync just pulled,
          // mirroring the manual data:sync-periods path — first provider's
          // daily only; everything else just refreshes caches.
          if (result.filesDownloaded > 0) {
            if (t === 'daily' && await isFirstProvider(app, provider)) {
              app.maintainRollup(changedRollupMonths(files.map(f => extractPeriod(f.key))));
            } else {
              app.warmupBase();
            }
          }
          return result;
        } catch (err: unknown) {
          // A duplicate-start rejection means another sync already owns this
          // key (the pre-check can lose a same-tick race). It is a no-op, not a
          // failure — must not clobber the live sync's status with 'failed'.
          if (err instanceof Error && err.message === SYNC_ALREADY_RUNNING) {
            return { filesDownloaded: 0, rowsProcessed: 0 };
          }
          // A user-initiated cancel is not a failure. Auto-syncs are now
          // cancellable (cancelSync keys by provider:tier and hits whichever
          // sync owns the key), so return the tier to idle instead of showing
          // 'Download cancelled' as an error — mirrors the manual path's
          // handleSyncError.
          if (err instanceof Error && err.message === 'Download cancelled') {
            state.syncStatuses[key] = { status: 'idle', lastSync: null };
            return { filesDownloaded: 0, rowsProcessed: 0 };
          }
          // Surface credential expiry / opaque `aws s3 sync` download failures as
          // the actionable "run aws sso login" message so the toolbar offers
          // one-click re-auth instead of a raw CLI error (mirrors getInventory).
          const error = toUserFriendlyError(err, providerAuth(provider));
          state.syncStatuses[key] = { status: 'failed', error, lastSync: null };
          throw error;
        }
      },
      getLocalPeriods: async (providerName: string, tier: string) => {
        const provider = await providerByName(app, providerName);
        const inv = await getLocalDataInventory(ctx.dataDir, provider.name, asTier(tier));
        return [...inv.local.periods];
      },
      deletePeriods: async (providerName: string, periods: readonly string[], tier: string) => {
        const provider = await providerByName(app, providerName);
        for (const period of periods) {
          await deleteLocalPeriodFiles(ctx.dataDir, provider.name, period, asTier(tier));
        }
        // Cascade the auto-prune into the rollup, once per unique daily month —
        // first provider only (the RollupStore is bound to it).
        if (asTier(tier) === 'daily' && await isFirstProvider(app, provider)) {
          for (const month of changedRollupMonths(periods)) {
            await cascadeRollupForDeletedMonth(app, month);
          }
        }
      },
    };
  }

  // The scheduler is shared by auto-sync and auto-prune: it must run whenever
  // EITHER is enabled, and stop only when both are off. Re-read both flags and
  // (re)start or stop accordingly. Call after any toggle/interval change.
  async function refreshScheduler(path: string): Promise<void> {
    const syncOn = await readAutoSyncEnabled(path);
    const pruneOn = await readAutoPruneEnabled(path);
    if (syncOn || pruneOn) {
      const minutes = await readAutoSyncIntervalMinutes(path);
      startAutoSync(buildAutoSyncDeps(ctx.syncClient), minutes);
    } else {
      stopAutoSync();
    }
  }

  ipcMain.handle('auto-sync:get-enabled', async (): Promise<boolean> => {
    return readAutoSyncEnabled(await autoSyncPrefsPath());
  });

  ipcMain.handle('auto-sync:set-enabled', async (_event, enabled: boolean): Promise<void> => {
    const path = await autoSyncPrefsPath();
    await writeAutoSyncEnabled(path, enabled);
    await refreshScheduler(path);
  });

  ipcMain.handle('auto-prune:get-enabled', async (): Promise<boolean> => {
    return readAutoPruneEnabled(await autoSyncPrefsPath());
  });

  ipcMain.handle('auto-prune:set-enabled', async (_event, enabled: boolean): Promise<void> => {
    const path = await autoSyncPrefsPath();
    await writeAutoPruneEnabled(path, enabled);
    await refreshScheduler(path);
  });

  ipcMain.handle('auto-sync:get-interval', async (): Promise<number> => {
    return readAutoSyncIntervalMinutes(await autoSyncPrefsPath());
  });

  ipcMain.handle('auto-sync:set-interval', async (_event, minutes: number): Promise<void> => {
    const path = await autoSyncPrefsPath();
    await writeAutoSyncIntervalMinutes(path, minutes);
    // Restart only if the scheduler is actually running (auto-sync or
    // auto-prune on) so the new interval takes effect; otherwise saving the
    // preference is enough and it'll be picked up next time one is enabled.
    await refreshScheduler(path);
  });

  ipcMain.handle('auto-sync:get-status', (): AutoSyncStatus => {
    return getAutoSyncStatus();
  });

  // Start the scheduler on launch if auto-sync or auto-prune was left enabled
  void autoSyncPrefsPath().then(refreshScheduler).catch(() => { /* auto-sync startup failure is non-fatal */ });
}
