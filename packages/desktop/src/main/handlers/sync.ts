import { ipcMain, shell } from 'electron';
import { dirname, basename } from 'node:path';
import {
  getDataInventory,
  getEtagFileName,
  getRawDirPrefix,
  parseEtagsJson,
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
import { readOptimizeEnabled, writeOptimizeEnabled } from '../optimize-enabled.js';

type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

function resolveDataType(syncId: string): ExpectedDataType {
  if (syncId === 'hourly') return 'hourly';
  if (syncId === 'cost-optimization') return 'cost-optimization';
  return 'daily';
}

export function registerSyncHandlers(app: AppContext): void {
  const { ctx, state, getConfig, activity, optimizeQueue } = app;
  const syncAbortControllers = new Map<string, AbortController>();

  ipcMain.handle('sync:get-file-activity', (_event, sinceIso?: string): ReturnType<typeof activity.since> => {
    return activity.since(sinceIso);
  });

  ipcMain.handle('sync:get-optimize-status', (): { queued: number; running: boolean } => {
    return { queued: optimizeQueue.size(), running: optimizeQueue.running() };
  });

  async function optimizePrefsPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(path.dirname(ctx.dataDir), 'app-preferences.json');
  }

  ipcMain.handle('optimize:get-enabled', async (): Promise<boolean> => {
    return readOptimizeEnabled(await optimizePrefsPath());
  });

  ipcMain.handle('optimize:set-enabled', async (_event, enabled: boolean): Promise<void> => {
    await writeOptimizeEnabled(await optimizePrefsPath(), enabled);
    if (enabled) optimizeQueue.kick();
  });

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

    // Data files for a period live under aws/raw/{prefix}-{period}/.
    // For cost-optimization the period field is a YYYY-MM-DD (per-day download)
    // — the directory name is e.g. cost-opt-2026-04-08 — so match on
    // ${prefix}-${period} OR ${prefix}-${period}-* to cover both cases.
    const prefix = getRawDirPrefix(tier);
    const rawDir = path.join(ctx.dataDir, 'aws', 'raw');
    const columnsDir = path.join(ctx.dataDir, 'aws', 'columns');
    let removedAny = false;
    const removedDirs: string[] = [];
    try {
      const entries = await fs.readdir(rawDir);
      for (const entry of entries) {
        if (entry === `${prefix}-${period}` || entry.startsWith(`${prefix}-${period}-`)) {
          await fs.rm(path.join(rawDir, entry), { recursive: true });
          // Also drop matching sidecars (otherwise they linger until regen).
          await fs.rm(path.join(columnsDir, entry), { recursive: true, force: true });
          logger.info(`Deleted local data (${tier}): ${entry}`);
          removedAny = true;
          removedDirs.push(entry);
        }
      }
    } catch {
      // raw dir may not exist
    }

    // Purge in-memory queue + activity for anything under the removed dirs,
    // otherwise the "Local optimizer" panel keeps listing files that no
    // longer exist on disk.
    if (removedDirs.length > 0) {
      const matches = (p: string): boolean => removedDirs.some(d => p.includes(`/${d}/`));
      optimizeQueue.removeWhere(matches);
      activity.removeWhere(matches);
    }

    // Drop the period from the etag manifest so the inventory marks it
    // 'missing' on the next refresh — otherwise stale etags can cause the
    // re-download path to skip files. Keys in the etag map can be the period
    // itself ('2026-04') or a date within it ('2026-04-08').
    const etagPath = path.join(ctx.dataDir, getEtagFileName(tier));
    try {
      const raw = await fs.readFile(etagPath, 'utf-8');
      const etags = parseEtagsJson(raw);
      const kept: Record<string, Record<string, string>> = {};
      let changed = false;
      for (const [key, value] of Object.entries(etags)) {
        if (key === period || key.startsWith(`${period}-`)) {
          changed = true;
          continue;
        }
        kept[key] = value;
      }
      if (changed) {
        await fs.writeFile(etagPath, JSON.stringify(kept, null, 2));
      }
    } catch {
      // etag file may not exist
    }

    if (!removedAny) {
      logger.info(`Delete (${tier}) for ${period}: nothing matched ${prefix}-${period}*`);
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

    const tier = resolveDataType(syncId);
    // Only daily/hourly tiers benefit from sidecar optimization. cost-opt
    // stays raw — the Savings view is already fast and its data shape differs.
    const optimizable = tier === 'daily' || tier === 'hourly';

    try {
      const result = await syncSelectedFiles({
        bucketPath,
        profile: provider.credentials.profile,
        dataDir: ctx.dataDir,
        expectedDataType: tier,
        files: fileEntries,
        signal: controller.signal,
        onFileDownloaded: optimizable ? (localPath) => {
          // Record the download event, then enqueue optimize. The queue drains
          // in parallel with subsequent downloads — the whole point of the
          // pipeline.
          const relName = `${basename(dirname(localPath))}/${basename(localPath)}`;
          activity.record({ rawPath: localPath, relName, stage: 'downloaded' });
          optimizeQueue.enqueue(localPath);
        } : undefined,
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
