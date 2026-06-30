import { ipcMain } from 'electron';
import { getDataInventory, getLocalDataInventory, extractPeriod, isCredentialError, writeTierLastSync } from '@costgoblin/core';
import type { AutoSyncStatus } from '@costgoblin/core';
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
import { type AppContext, prefsPath, toUserFriendlyError } from './context.js';
import type { SyncClient } from '../sync-client.js';
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

export function registerAutoSyncHandlers(app: AppContext): void {
  const { ctx, state, getConfig } = app;

  const autoSyncPrefsPath = () => prefsPath(ctx.dataDir, 'app-preferences');

  function buildAutoSyncDeps(syncClient: SyncClient) {
    return {
      onLog: recordSyncLog,
      getPrefsPath: autoSyncPrefsPath,
      getConfig: async () => {
        const config = await getConfig();
        return { providers: [...config.providers] };
      },
      getInventory: async (tier: string) => {
        const config = await getConfig();
        const provider = config.providers[0];
        if (provider === undefined) return { periods: [] };
        const tierBucket = tier === 'cost-optimization'
          ? provider.sync.costOptimization?.bucket ?? provider.sync.daily.bucket
          : provider.sync.daily.bucket;
        const bucket = tier === 'hourly'
          ? provider.sync.hourly?.bucket ?? provider.sync.daily.bucket
          : tierBucket;
        let inv;
        try {
          inv = await getDataInventory(bucket, provider.credentials.profile, ctx.dataDir, asTier(tier));
        } catch (err: unknown) {
          // Rewrite credential failures into the actionable "run aws sso login"
          // message so the scheduler surfaces it (instead of silently skipping)
          // and the toolbar shows why background sync stopped.
          if (isCredentialError(err)) throw toUserFriendlyError(err, provider.credentials.profile);
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
      syncPeriods: async (files: { key: string; contentHash: string; size: number }[], tier: string) => {
        const config = await getConfig();
        const provider = config.providers[0];
        if (provider === undefined) return { filesDownloaded: 0, rowsProcessed: 0 };
        const syncTierBucket = tier === 'cost-optimization'
          ? provider.sync.costOptimization?.bucket ?? provider.sync.daily.bucket
          : provider.sync.daily.bucket;
        const bucket = tier === 'hourly'
          ? provider.sync.hourly?.bucket ?? provider.sync.daily.bucket
          : syncTierBucket;

        const syncId = asTier(tier);
        state.syncStatuses[syncId] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: files.length, filesDone: 0, bytesTotal: 0, bytesDone: 0, message: '' };
        try {
          const result = await syncClient.syncPeriods({
            bucketPath: bucket,
            profile: provider.credentials.profile,
            dataDir: ctx.dataDir,
            tier: syncId,
            files,
            onProgress: (progress) => {
              const bytesDone = progress.bytesDone ?? 0;
              const bytesTotal = progress.bytesTotal ?? 0;
              const fraction = computeSyncFraction(bytesDone, bytesTotal, progress.filesDone, progress.filesTotal);
              state.syncStatuses[syncId] = {
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
          state.syncStatuses[syncId] = { status: 'completed', lastSync: now, filesDownloaded: result.filesDownloaded };
          // Best-effort: cosmetic timestamp; a write failure must not flip this
          // successful sync to 'failed' (the catch below would do exactly that).
          await writeTierLastSync(ctx.dataDir, syncId, now.toISOString()).catch(() => { /* cosmetic */ });
          // Keep the rollup in step with the raw the auto-sync just pulled,
          // mirroring the manual data:sync-periods path.
          if (result.filesDownloaded > 0) {
            if (syncId === 'daily') app.maintainRollup(changedRollupMonths(files.map(f => extractPeriod(f.key))));
            else app.warmupBase();
          }
          return result;
        } catch (err: unknown) {
          // Surface credential expiry / opaque `aws s3 sync` download failures as
          // the actionable "run aws sso login" message so the toolbar offers
          // one-click re-auth instead of a raw CLI error (mirrors getInventory).
          const error = toUserFriendlyError(err, provider.credentials.profile);
          state.syncStatuses[syncId] = { status: 'failed', error, lastSync: null };
          throw error;
        }
      },
      getLocalPeriods: async (tier: string) => {
        const inv = await getLocalDataInventory(ctx.dataDir, asTier(tier));
        return [...inv.local.periods];
      },
      deletePeriods: async (periods: readonly string[], tier: string) => {
        for (const period of periods) {
          await deleteLocalPeriodFiles(ctx.dataDir, period, asTier(tier));
        }
        // Cascade the auto-prune into the rollup, once per unique daily month.
        if (asTier(tier) === 'daily') {
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
