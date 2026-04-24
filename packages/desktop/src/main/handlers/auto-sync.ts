import { ipcMain } from 'electron';
import { getDataInventory } from '@costgoblin/core';
import type { AutoSyncStatus } from '@costgoblin/core';
import {
  startAutoSync,
  stopAutoSync,
  getAutoSyncStatus,
  readAutoSyncEnabled,
  writeAutoSyncEnabled,
  readAutoSyncIntervalMinutes,
  writeAutoSyncIntervalMinutes,
} from '../auto-sync.js';
import type { AppContext } from './context.js';
import type { SyncClient } from '../sync-client.js';

type Tier = 'daily' | 'hourly' | 'cost-optimization';

function asTier(s: string): Tier {
  if (s === 'hourly' || s === 'cost-optimization') return s;
  return 'daily';
}

export function registerAutoSyncHandlers(app: AppContext): void {
  const { ctx, getConfig } = app;

  async function autoSyncPrefsPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(path.dirname(ctx.dataDir), 'app-preferences.json');
  }

  function buildAutoSyncDeps(syncClient: SyncClient) {
    return {
      getPrefsPath: autoSyncPrefsPath,
      getConfig: async () => {
        const config = await getConfig();
        return { providers: [...config.providers] };
      },
      getInventory: async (tier: string) => {
        const config = await getConfig();
        const provider = config.providers[0];
        if (provider === undefined) return { periods: [] };
        const bucket = tier === 'hourly'
          ? provider.sync.hourly?.bucket ?? provider.sync.daily.bucket
          : tier === 'cost-optimization'
            ? provider.sync.costOptimization?.bucket ?? provider.sync.daily.bucket
            : provider.sync.daily.bucket;
        const inv = await getDataInventory(bucket, provider.credentials.profile, ctx.dataDir, asTier(tier));
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
        const bucket = tier === 'hourly'
          ? provider.sync.hourly?.bucket ?? provider.sync.daily.bucket
          : tier === 'cost-optimization'
            ? provider.sync.costOptimization?.bucket ?? provider.sync.daily.bucket
            : provider.sync.daily.bucket;

        // Use worker thread via SyncClient
        return syncClient.syncPeriods({
          bucketPath: bucket,
          profile: provider.credentials.profile,
          dataDir: ctx.dataDir,
          tier: asTier(tier),
          files,
          // No onProgress for background sync (silent operation)
        });
      },
    };
  }

  ipcMain.handle('auto-sync:get-enabled', async (): Promise<boolean> => {
    return readAutoSyncEnabled(await autoSyncPrefsPath());
  });

  ipcMain.handle('auto-sync:set-enabled', async (_event, enabled: boolean): Promise<void> => {
    const prefsPath = await autoSyncPrefsPath();
    await writeAutoSyncEnabled(prefsPath, enabled);
    if (enabled) {
      const minutes = await readAutoSyncIntervalMinutes(prefsPath);
      startAutoSync(buildAutoSyncDeps(ctx.syncClient), minutes);
    } else {
      stopAutoSync();
    }
  });

  ipcMain.handle('auto-sync:get-interval', async (): Promise<number> => {
    return readAutoSyncIntervalMinutes(await autoSyncPrefsPath());
  });

  ipcMain.handle('auto-sync:set-interval', async (_event, minutes: number): Promise<void> => {
    const prefsPath = await autoSyncPrefsPath();
    await writeAutoSyncIntervalMinutes(prefsPath, minutes);
    // Only restart the scheduler if auto-sync is actually on — otherwise
    // saving the preference is enough; the new interval will be picked up
    // next time the user flips the toggle.
    const enabled = await readAutoSyncEnabled(prefsPath);
    if (enabled) {
      const stored = await readAutoSyncIntervalMinutes(prefsPath);
      startAutoSync(buildAutoSyncDeps(ctx.syncClient), stored);
    }
  });

  ipcMain.handle('auto-sync:get-status', (): AutoSyncStatus => {
    return getAutoSyncStatus();
  });

  // Start auto-sync on launch if previously enabled
  void autoSyncPrefsPath().then(async (prefsPath) => {
    const enabled = await readAutoSyncEnabled(prefsPath);
    if (enabled) {
      const minutes = await readAutoSyncIntervalMinutes(prefsPath);
      startAutoSync(buildAutoSyncDeps(ctx.syncClient), minutes);
    }
  }).catch(() => { /* auto-sync startup failure is non-fatal */ });
}
