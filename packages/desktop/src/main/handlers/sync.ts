import { ipcMain, shell } from 'electron';
import {
  getDataInventory,
  getLocalDataInventory,
  hasSyncedTier,
  getEtagFileName,
  getRawDirPrefix,
  parseEtagsJson,
  extractPeriod,
  listLocalMonths,
  configuredTierRetentions,
  periodsOutsideRetention,
  readTierLastSync,
  writeTierLastSync,
  isCredentialError,
  logger,
} from '@costgoblin/core';
import type {
  CostGoblinConfig,
  DataInventory,
  DataTier,
  ManifestFileEntry,
  AccountMappingStatus,
  AccountMappingEntry,
  PruneResult,
  SyncStatus,
} from '@costgoblin/core';
import {
  type AppContext,
  type AppState,
  type IpcContext,
  toUserFriendlyError,
} from './context.js';
import { triggerAutoSyncNow } from '../auto-sync.js';
import { traceSpan, SPAN_OP } from '../telemetry/tracing.js';

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

// Prefer byte-fraction for the headline progress number — it's smooth
// mid-flight, where filesDone/filesTotal stays at 0 until each file fully
// completes. Falls back to the file-count fraction before the first
// "Completed" line lands.
function computeSyncFraction(bytesDone: number, bytesTotal: number, filesDone: number, filesTotal: number): number {
  if (bytesTotal > 0) return bytesDone / bytesTotal;
  if (filesTotal > 0) return filesDone / filesTotal;
  return 0;
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

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/;

/** Remove a single local billing period (raw dirs + etag entries) for a tier.
 *  Shared by the manual delete handler, the prune handler, and auto-prune so
 *  they all delete data identically. Returns whether any files were removed. */
export async function deleteLocalPeriodFiles(
  dataDir: string,
  period: string,
  tier: ExpectedDataType,
): Promise<boolean> {
  if (!PERIOD_RE.test(period)) {
    throw new Error(`Invalid period format: "${period}" — expected YYYY-MM or YYYY-MM-DD`);
  }
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const prefix = getRawDirPrefix(tier);
  const rawDir = path.join(dataDir, 'aws', 'raw');

  const removedAny = await removeMatchingDirs(rawDir, prefix, period, fs, path);
  if (removedAny) {
    logger.info(`Deleted local data (${tier}): ${prefix}-${period}*`);
  }

  await pruneEtagFile(path.join(dataDir, getEtagFileName(tier)), period, fs);

  if (!removedAny) {
    logger.info(`Delete (${tier}) for ${period}: nothing matched ${prefix}-${period}*`);
  }
  return removedAny;
}

/** Cascade a deleted daily month into the rollup: re-roll it from the raw
 *  that's left, or drop its partition if the month is now fully gone. Daily
 *  tier only — hourly / cost-opt don't feed the daily rollup. Shared by the
 *  manual delete/prune handlers and auto-prune. */
export async function cascadeRollupForDeletedMonth(app: AppContext, month: string): Promise<void> {
  const monthsLeft = await listLocalMonths(app.ctx.dataDir, 'daily');
  if (monthsLeft.includes(month)) app.maintainRollup([month]);
  else await app.rollupStore.deletePeriod(month);
}

/** Periods (etag keys / dir names) → the unique YYYY-MM rollup partitions they
 *  touch, for re-rolling the daily rollup after a sync or delete. */
export function changedRollupMonths(periods: readonly string[]): string[] {
  return [...new Set(periods.map(p => p.slice(0, 7)))].filter(p => /^\d{4}-\d{2}$/.test(p));
}

export function registerSyncHandlers(app: AppContext): void {
  const { ctx, state, getConfig } = app;
  const syncWorkerIds = new Map<string, number>();
  let nextWorkerId = 0;

  ipcMain.handle('sync:status', async (_event, syncId: string = 'default'): Promise<SyncStatus> => {
    const current = state.syncStatuses[syncId];
    if (current === undefined) {
      const iso = await readTierLastSync(ctx.dataDir, syncId);
      return { status: 'idle', lastSync: iso === null ? null : new Date(iso) };
    }
    // The in-memory lastSync resets to null on every launch; backfill it from the
    // durable timestamp file so the toolbar can show "Synced <time>" after a
    // restart for tiers that aren't mid-sync.
    if ((current.status === 'idle' || current.status === 'failed') && current.lastSync === null) {
      const iso = await readTierLastSync(ctx.dataDir, syncId);
      if (iso !== null) return { ...current, lastSync: new Date(iso) };
    }
    return current;
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
      // Expired/invalid credentials on an install that has synced this tier from
      // S3 before (its etag file exists) is a real auth failure, not the
      // imported-snapshot case — surface it so the user re-authenticates instead
      // of silently showing stale local data as if everything were up to date.
      if (isCredentialError(err) && await hasSyncedTier(ctx.dataDir, t)) {
        throw toUserFriendlyError(err, provider.credentials.profile);
      }
      // Otherwise fall back to a disk-only inventory so a consumer that imported
      // a shared snapshot (no S3 access) still sees the data it has.
      const local = await getLocalDataInventory(ctx.dataDir, t);
      if (local.totalLocalPeriods > 0) {
        logger.info('S3 inventory unavailable — using local-only inventory', { tier: t });
        return local;
      }
      throw toUserFriendlyError(err, provider.credentials.profile);
    }
  });

  ipcMain.handle('data:delete-period', async (_event, period: string, tier: ExpectedDataType = 'daily'): Promise<void> => {
    await deleteLocalPeriodFiles(ctx.dataDir, period, tier);
    if (tier === 'daily') await cascadeRollupForDeletedMonth(app, period.slice(0, 7));
  });

  // Manual prune: drop every local period that has fallen outside its tier's
  // retention window, across all configured tiers. Local-only — derives the
  // on-disk period list from getLocalDataInventory, so it works without any S3
  // access. Returns what was removed so the UI can report it.
  ipcMain.handle('data:prune', async (): Promise<PruneResult> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');

    const deleted: { tier: DataTier; period: string }[] = [];
    for (const { tier, retentionDays } of configuredTierRetentions(provider.sync)) {
      const local = await getLocalDataInventory(ctx.dataDir, tier);
      const expired = periodsOutsideRetention(local.local.periods, retentionDays);
      for (const period of expired) {
        const removed = await deleteLocalPeriodFiles(ctx.dataDir, period, tier);
        if (removed) deleted.push({ tier, period });
      }
    }
    // Cascade the prune into the rollup, once per unique daily month removed.
    for (const month of changedRollupMonths(deleted.filter(d => d.tier === 'daily').map(d => d.period))) {
      await cascadeRollupForDeletedMonth(app, month);
    }
    if (deleted.length > 0) {
      logger.info(`Prune: removed ${String(deleted.length)} period(s) outside retention`);
    }
    return { deleted };
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
      const result = await traceSpan(
        {
          name: 'sync.s3',
          op: SPAN_OP.sync,
          forceTransaction: true,
          attributes: { 'sync.tier': tier, 'sync.files_requested': fileEntries.length },
        },
        async (span) => {
          const r = await runSync(ctx, provider.credentials.profile, bucketPath, tier, fileEntries, syncId, state);
          span?.setAttribute('sync.files_downloaded', r.filesDownloaded);
          span?.setAttribute('sync.rows_processed', r.rowsProcessed);
          return r;
        },
      );
      syncWorkerIds.delete(syncId);

      const now = new Date();
      state.syncStatuses[syncId] = { status: 'completed', lastSync: now, filesDownloaded: result.filesDownloaded };
      // Best-effort: the persisted timestamp is cosmetic and self-heals on the
      // next sync, so a write failure must never fail the (successful) sync.
      await writeTierLastSync(ctx.dataDir, tier, now.toISOString()).catch(() => { /* cosmetic */ });
      if (result.filesDownloaded > 0) {
        if (tier === 'daily') {
          // Re-roll only the daily partitions this sync touched (file replace).
          app.maintainRollup(changedRollupMonths(fileEntries.map(e => extractPeriod(e.key))));
        } else {
          // Hourly / cost-opt don't feed the daily rollup; just refresh caches.
          app.warmupBase();
        }
      }
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
      // The promise resolves on spawn (the browser is now opening), but the CLI
      // keeps running until the user finishes authenticating. On a *successful*
      // login (exit 0) kick an immediate sync so data refreshes right away
      // instead of waiting up to a full auto-sync interval — and so the "Last
      // sync" timestamp self-heals. No-op when auto-sync is disabled.
      child.on('exit', (code) => {
        if (code === 0) triggerAutoSyncNow();
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
  const error = toUserFriendlyError(err, profile);
  logger.error(`Selective sync '${syncId}' failed: ${error.message}`);
  state.syncStatuses[syncId] = { status: 'failed', error, lastSync: null };
  return error;
}

export { resolveDataType };
