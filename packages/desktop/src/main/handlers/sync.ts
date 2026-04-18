import { ipcMain, shell } from 'electron';
import {
  getDataInventory,
  syncSelectedFiles,
  logger,
} from '@costgoblin/core';
import type {
  DataInventory,
  ManifestFileEntry,
  AccountMappingStatus,
  AccountMappingEntry,
  SyncStatus,
} from '@costgoblin/core';
import {
  type AppContext,
  isCredentialError,
  toUserFriendlyError,
} from './context.js';

type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

function resolveDataType(syncId: string): ExpectedDataType {
  if (syncId === 'hourly') return 'hourly';
  if (syncId === 'cost-optimization') return 'cost-optimization';
  return 'daily';
}

export function registerSyncHandlers(app: AppContext): void {
  const { ctx, state, getConfig } = app;
  const syncAbortControllers = new Map<string, AbortController>();

  ipcMain.handle('sync:status', (_event, syncId: string = 'default'): SyncStatus => {
    return state.syncStatuses[syncId] ?? { status: 'idle', lastSync: null };
  });

  ipcMain.handle('data:inventory', async (_event, tier?: ExpectedDataType): Promise<DataInventory> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');
    const t = tier ?? 'daily';
    let bucket: string;
    if (t === 'hourly') {
      bucket = provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
    } else if (t === 'cost-optimization') {
      const costOptBucket = provider.sync.costOptimization?.bucket;
      if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
      bucket = costOptBucket;
    } else {
      bucket = provider.sync.daily.bucket;
    }
    try {
      return await getDataInventory(bucket, provider.credentials.profile, ctx.dataDir, t);
    } catch (err: unknown) {
      throw toUserFriendlyError(err, provider.credentials.profile);
    }
  });

  ipcMain.handle('data:delete-period', async (_event, period: string, tier: ExpectedDataType = 'daily'): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const tierDir = path.join(ctx.dataDir, 'aws', tier);
    try {
      const entries = await fs.readdir(tierDir);
      for (const entry of entries) {
        if (entry.startsWith(`usage_date=${period}`)) {
          await fs.rm(path.join(tierDir, entry), { recursive: true });
          logger.info(`Deleted local partition (${tier}): ${entry}`);
        }
      }
    } catch {
      // dir may not exist
    }
  });

  ipcMain.handle('data:sync-periods', async (_event, fileEntries: ManifestFileEntry[], syncId: string = 'default'): Promise<{ filesDownloaded: number; rowsProcessed: number }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');

    let bucketPath: string;
    if (syncId === 'hourly') {
      bucketPath = provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
    } else if (syncId === 'cost-optimization') {
      const costOptBucket = provider.sync.costOptimization?.bucket;
      if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
      bucketPath = costOptBucket;
    } else {
      bucketPath = provider.sync.daily.bucket;
    }

    const controller = new AbortController();
    syncAbortControllers.set(syncId, controller);
    state.syncStatuses[syncId] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: fileEntries.length, filesDone: 0, message: '' };

    try {
      const result = await syncSelectedFiles({
        bucketPath,
        profile: provider.credentials.profile,
        dataDir: ctx.dataDir,
        expectedDataType: resolveDataType(syncId),
        files: fileEntries,
        signal: controller.signal,
        onProgress: (progress) => {
          state.syncStatuses[syncId] = {
            status: 'syncing',
            phase: progress.phase === 'repartitioning' ? 'repartitioning' : 'downloading',
            progress: progress.filesTotal > 0 ? progress.filesDone / progress.filesTotal : 0,
            filesTotal: progress.filesTotal,
            filesDone: progress.filesDone,
            message: progress.message ?? '',
          };
        },
      });

      syncAbortControllers.delete(syncId);
      state.syncStatuses[syncId] = { status: 'completed', lastSync: new Date(), filesDownloaded: result.filesDownloaded };
      return result;
    } catch (err: unknown) {
      syncAbortControllers.delete(syncId);
      const raw = err instanceof Error ? err : new Error(String(err));
      if (raw.message === 'Download cancelled') {
        state.syncStatuses[syncId] = { status: 'idle', lastSync: null };
        return { filesDownloaded: 0, rowsProcessed: 0 };
      }
      const error = isCredentialError(err) ? toUserFriendlyError(err, provider.credentials.profile) : raw;
      logger.error(`Selective sync '${syncId}' failed: ${error.message}`);
      state.syncStatuses[syncId] = { status: 'failed', error, lastSync: null };
      throw error;
    }
  });

  ipcMain.handle('data:cancel-sync', (_event, syncId: string = 'default'): void => {
    const controller = syncAbortControllers.get(syncId);
    if (controller !== undefined) {
      controller.abort();
      logger.info(`Sync '${syncId}' cancelled by user`);
    }
  });

  ipcMain.handle('data:open-folder', async (): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(ctx.dataDir, { recursive: true });
    await shell.openPath(ctx.dataDir);
  });

  ipcMain.handle('data:account-mapping', async (): Promise<AccountMappingStatus> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const rawDir = path.join(path.dirname(ctx.dataDir), 'raw');
    let csvPath: string | null = null;

    try {
      const entries = await fs.readdir(rawDir);
      const csvFile = entries.find(e => e.toLowerCase().endsWith('.csv') && e.toLowerCase().includes('account'));
      if (csvFile !== undefined) {
        csvPath = path.join(rawDir, csvFile);
      }
    } catch {
      return { status: 'missing' };
    }

    if (csvPath === null) return { status: 'missing' };

    const content = await fs.readFile(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const headerLine = lines[0];
    if (headerLine === undefined) return { status: 'missing' };

    const accounts: AccountMappingEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      const accountId = cols[0] ?? '';
      const name = cols[4] ?? '';
      const orgPath = cols[2] ?? '';
      const email = cols[3] ?? '';
      const accountState = cols[5] ?? '';
      if (accountId.length > 0) {
        accounts.push({ accountId, name, orgPath, email, state: accountState });
      }
    }

    return { status: 'found', accounts, path: csvPath };
  });
}

export { resolveDataType };
