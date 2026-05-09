import { ipcMain, shell } from 'electron';
import {
  getDataInventory,
  getEtagFileName,
  getRawDirPrefix,
  parseEtagsJson,
  logger,
} from '@costgoblin/core';
import type {
  CostGoblinConfig,
  DataInventory,
  ManifestFileEntry,
  AccountMappingStatus,
  AccountMappingEntry,
  SyncStatus,
} from '@costgoblin/core';
import {
  type AppContext,
  type AppState,
  type IpcContext,
  isCredentialError,
  toUserFriendlyError,
} from './context.js';

type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

function resolveDataType(syncId: string): ExpectedDataType {
  if (syncId === 'hourly') return 'hourly';
  if (syncId === 'cost-optimization') return 'cost-optimization';
  return 'daily';
}

function resolveBucketPath(config: CostGoblinConfig, syncId: string): string {
  const provider = config.providers[0];
  if (provider === undefined) throw new Error('No provider configured');
  if (syncId === 'hourly') {
    return provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
  }
  if (syncId === 'cost-optimization') {
    const costOptBucket = provider.sync.costOptimization?.bucket;
    if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
    return costOptBucket;
  }
  return provider.sync.daily.bucket;
}

function matchesPeriodPrefix(entry: string, prefix: string, period: string): boolean {
  return entry === `${prefix}-${period}` || entry.startsWith(`${prefix}-${period}-`);
}

async function removeMatchingDirs(
  dir: string,
  prefix: string,
  period: string,
  fs: typeof import('node:fs/promises'),
  path: typeof import('node:path'),
): Promise<boolean> {
  let removedAny = false;
  try {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      if (!matchesPeriodPrefix(entry, prefix, period)) continue;
      await fs.rm(path.join(dir, entry), { recursive: true });
      removedAny = true;
    }
  } catch {
    // dir may not exist
  }
  return removedAny;
}

async function pruneEtagFile(
  etagPath: string,
  period: string,
  fs: typeof import('node:fs/promises'),
): Promise<void> {
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
}

export function registerSyncHandlers(app: AppContext): void {
  const { ctx, state, getConfig } = app;
  const syncWorkerIds = new Map<string, number>();
  let nextWorkerId = 0;

  ipcMain.handle('sync:status', (_event, syncId: string = 'default'): SyncStatus => {
    return state.syncStatuses[syncId] ?? { status: 'idle', lastSync: null };
  });

  ipcMain.handle('data:inventory', async (_event, tier?: ExpectedDataType): Promise<DataInventory> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');
    const t = tier ?? 'daily';
    const bucket = resolveBucketPath(config, t);
    try {
      return await getDataInventory(bucket, provider.credentials.profile, ctx.dataDir, t);
    } catch (err: unknown) {
      throw toUserFriendlyError(err, provider.credentials.profile);
    }
  });

  ipcMain.handle('data:delete-period', async (_event, period: string, tier: ExpectedDataType = 'daily'): Promise<void> => {
    if (!/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/.test(period)) {
      throw new Error(`Invalid period format: "${period}" — expected YYYY-MM or YYYY-MM-DD`);
    }
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const prefix = getRawDirPrefix(tier);
    const rawDir = path.join(ctx.dataDir, 'aws', 'raw');

    const removedAny = await removeMatchingDirs(rawDir, prefix, period, fs, path);
    if (removedAny) {
      logger.info(`Deleted local data (${tier}): ${prefix}-${period}*`);
    }

    await pruneEtagFile(path.join(ctx.dataDir, getEtagFileName(tier)), period, fs);

    if (!removedAny) {
      logger.info(`Delete (${tier}) for ${period}: nothing matched ${prefix}-${period}*`);
    }
  });

  ipcMain.handle('data:sync-periods', async (_event, fileEntries: ManifestFileEntry[], syncId: string = 'default'): Promise<{ filesDownloaded: number; rowsProcessed: number }> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');

    const bucketPath = resolveBucketPath(config, syncId);
    const workerId = nextWorkerId++;
    syncWorkerIds.set(syncId, workerId);
    state.syncStatuses[syncId] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: fileEntries.length, filesDone: 0, bytesTotal: 0, bytesDone: 0, message: '' };

    const tier = resolveDataType(syncId);

    try {
      const result = await runSync(ctx, provider.credentials.profile, bucketPath, tier, fileEntries, syncId, state);
      syncWorkerIds.delete(syncId);

      state.syncStatuses[syncId] = { status: 'completed', lastSync: new Date(), filesDownloaded: result.filesDownloaded };
      if (result.filesDownloaded > 0) app.warmupBase();
      return result;
    } catch (err: unknown) {
      syncWorkerIds.delete(syncId);
      const error = handleSyncError(err, syncId, provider.credentials.profile, state);
      if (error.message === 'Download cancelled') {
        return { filesDownloaded: 0, rowsProcessed: 0 };
      }
      throw error;
    }
  });

  ipcMain.handle('data:cancel-sync', (_event, syncId: string = 'default'): void => {
    const workerId = syncWorkerIds.get(syncId);
    if (workerId !== undefined) {
      ctx.syncClient.cancelSync(workerId);
      logger.info(`Sync '${syncId}' cancelled by user`);
    }
  });

  ipcMain.handle('data:open-folder', async (): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(ctx.dataDir, { recursive: true });
    await shell.openPath(ctx.dataDir);
  });

  ipcMain.handle('data:sso-login', async (_event, profile: string): Promise<void> => {
    const { spawn } = await import('node:child_process');
    const { delimiter } = await import('node:path');
    const currentPath = process.env['PATH'] ?? '';
    const extraPaths = process.platform === 'win32'
      ? []
      : ['/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
    const fullPath = [...new Set([...currentPath.split(delimiter), ...extraPaths])].join(delimiter);
    return new Promise<void>((resolve, reject) => {
      const child = spawn('aws', ['sso', 'login', '--profile', profile], {
        stdio: 'ignore',
        detached: true,
        shell: process.platform === 'win32',
        env: { ...process.env, PATH: fullPath },
      });
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(new Error('AWS_CLI_NOT_FOUND'));
        } else {
          reject(err);
        }
      });
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
    });
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
      const cols = line.split(',').map(c => c.replaceAll(/^"|"$/g, '').trim());
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

async function runSync(
  ctx: IpcContext,
  profile: string,
  bucketPath: string,
  tier: ExpectedDataType,
  fileEntries: readonly ManifestFileEntry[],
  syncId: string,
  state: AppState,
): Promise<{ filesDownloaded: number; rowsProcessed: number }> {
  return ctx.syncClient.syncPeriods({
    bucketPath,
    profile,
    dataDir: ctx.dataDir,
    tier,
    files: fileEntries,
    onProgress: (progress) => {
      const bytesDone = progress.bytesDone ?? 0;
      const bytesTotal = progress.bytesTotal ?? 0;
      // Prefer byte-fraction for the headline progress number — it's smooth
      // mid-flight, where filesDone/filesTotal stays at 0 until each file
      // fully completes. Falls back to the file-count fraction before the
      // first "Completed" line lands.
      const fraction = bytesTotal > 0
        ? bytesDone / bytesTotal
        : (progress.filesTotal > 0 ? progress.filesDone / progress.filesTotal : 0);
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
}

function handleSyncError(
  err: unknown,
  syncId: string,
  profile: string,
  state: AppState,
): Error {
  const raw = err instanceof Error ? err : new Error(String(err));
  if (raw.message === 'Download cancelled') {
    state.syncStatuses[syncId] = { status: 'idle', lastSync: null };
    return raw;
  }
  const error = isCredentialError(err) ? toUserFriendlyError(err, profile) : raw;
  logger.error(`Selective sync '${syncId}' failed: ${error.message}`);
  state.syncStatuses[syncId] = { status: 'failed', error, lastSync: null };
  return error;
}

export { resolveDataType };
