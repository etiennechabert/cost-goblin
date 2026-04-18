import { ipcMain } from 'electron';
import { getDataInventory, syncSelectedFiles } from '@costgoblin/core';
import type { AutoSyncStatus } from '@costgoblin/core';
import {
  startAutoSync,
  stopAutoSync,
  getAutoSyncStatus,
  readAutoSyncEnabled,
  writeAutoSyncEnabled,
} from '../auto-sync.js';
import type { AppContext } from './context.js';

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

  function buildAutoSyncDeps() {
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
        if (provider === undefined) return { filesDownloaded: 0 };
        const bucket = tier === 'hourly'
          ? provider.sync.hourly?.bucket ?? provider.sync.daily.bucket
          : tier === 'cost-optimization'
            ? provider.sync.costOptimization?.bucket ?? provider.sync.daily.bucket
            : provider.sync.daily.bucket;
        return syncSelectedFiles({
          bucketPath: bucket,
          profile: provider.credentials.profile,
          dataDir: ctx.dataDir,
          expectedDataType: asTier(tier),
          files,
        });
      },
    };
  }

  ipcMain.handle('auto-sync:get-enabled', async (): Promise<boolean> => {
    return readAutoSyncEnabled(await autoSyncPrefsPath());
  });

  ipcMain.handle('auto-sync:set-enabled', async (_event, enabled: boolean): Promise<void> => {
    await writeAutoSyncEnabled(await autoSyncPrefsPath(), enabled);
    if (enabled) {
      startAutoSync(buildAutoSyncDeps(), 60);
    } else {
      stopAutoSync();
    }
  });

  ipcMain.handle('auto-sync:get-status', (): AutoSyncStatus => {
    return getAutoSyncStatus();
  });

  // Start auto-sync on launch if previously enabled
  void autoSyncPrefsPath().then(async (prefsPath) => {
    const enabled = await readAutoSyncEnabled(prefsPath);
    if (enabled) {
      startAutoSync(buildAutoSyncDeps(), 60);
    }
  }).catch(() => { /* auto-sync startup failure is non-fatal */ });
}
