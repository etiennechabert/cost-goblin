import { ipcMain, shell } from 'electron';
import {
  getDataInventory,
  getLocalDataInventory,
  hasSyncedTier,
  getRawDirPrefix,
  parseEtagsJson,
  extractPeriod,
  listLocalMonths,
  configuredTierRetentions,
  periodsOutsideRetention,
  providerEtagPath,
  providerRawDir,
  readTierLastSync,
  writeTierLastSync,
  resolveBucketPath,
  findGcloudCli,
  gcloudCliFound,
  gcloudSearchPaths,
  logger,
  providerAuth,
} from '@costgoblin/core';
import type {
  DataInventoryResult,
  DataTier,
  ManifestFileEntry,
  AccountMappingStatus,
  AccountMappingEntry,
  GcloudLoginMode,
  ProviderAuth,
  ProviderConfig,
  ProviderName,
  PruneResult,
  SyncProgress,
  SyncStatus,
} from '@costgoblin/core';
import {
  type AppContext,
  type AppState,
  isAnyCredentialError,
  toUserFriendlyError,
} from './context.js';
import { triggerAutoSyncNow } from '../auto-sync.js';
import { SYNC_ALREADY_RUNNING } from '../sync-client.js';
import { parseSyncId, resolveProvider, resolveSyncId } from '../sync-id.js';
import { recordSyncLog } from '../sync-log.js';
import { traceSpan, SPAN_OP } from '../telemetry/tracing.js';

type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

/** Tier addressed by a (legacy or composite) syncId — legacy mapping:
 *  'default' and any unrecognized tier-only id mean the daily tier. */
function resolveDataType(syncId: string): ExpectedDataType {
  return parseSyncId(syncId).tier;
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
  provider: ProviderName,
  period: string,
  tier: ExpectedDataType,
): Promise<boolean> {
  if (!PERIOD_RE.test(period)) {
    throw new Error(`Invalid period format: "${period}" — expected YYYY-MM or YYYY-MM-DD`);
  }
  const fs = await import('node:fs/promises');
  const path = await import('node:path');

  const prefix = getRawDirPrefix(tier);
  const rawDir = providerRawDir(dataDir, provider);

  const removedAny = await removeMatchingDirs(rawDir, prefix, period, fs, path);
  if (removedAny) {
    logger.info(`Deleted local data (${tier}): ${prefix}-${period}*`);
    recordSyncLog('info', `Deleted local data (${tier}): ${prefix}-${period}`);
  }

  await pruneEtagFile(providerEtagPath(dataDir, provider, tier), period, fs);

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
  const provider = await app.getFirstProviderName();
  if (provider === null) return;
  const monthsLeft = await listLocalMonths(app.ctx.dataDir, provider, 'daily');
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

  ipcMain.handle('sync:status', async (_event, syncId: string = 'default'): Promise<SyncStatus> => {
    // While onboarding (no config / no providers) nothing was ever synced.
    const config = await getConfig().catch(() => null);
    if (config === null || config.providers.length === 0) return { status: 'idle', lastSync: null };
    const { provider, tier, key } = resolveSyncId(syncId, config.providers);
    const current = state.syncStatuses[key];
    if (current === undefined) {
      const iso = await readTierLastSync(ctx.dataDir, provider.name, tier);
      return { status: 'idle', lastSync: iso === null ? null : new Date(iso) };
    }
    // The in-memory lastSync resets to null on every launch; backfill it from the
    // durable timestamp file so the toolbar can show "Synced <time>" after a
    // restart for (provider, tier) pairs that aren't mid-sync.
    if ((current.status === 'idle' || current.status === 'failed') && current.lastSync === null) {
      const iso = await readTierLastSync(ctx.dataDir, provider.name, tier);
      if (iso !== null) return { ...current, lastSync: new Date(iso) };
    }
    return current;
  });

  ipcMain.handle('data:inventory', async (_event, tier?: ExpectedDataType, providerName?: string): Promise<DataInventoryResult> => {
    const config = await getConfig();
    const provider = resolveProvider(config.providers, providerName);
    const t = tier ?? 'daily';
    const bucket = resolveBucketPath(provider, t);
    try {
      const inv = await getDataInventory(bucket, providerAuth(provider), ctx.dataDir, provider.name, t);
      return { ...inv, provider: provider.name };
    } catch (err: unknown) {
      // Expired/invalid credentials on an install that has synced this tier from
      // S3 before (its etag file exists) is a real auth failure, not the
      // imported-snapshot case — surface it so the user re-authenticates instead
      // of silently showing stale local data as if everything were up to date.
      if (isAnyCredentialError(err) && await hasSyncedTier(ctx.dataDir, provider.name, t)) {
        throw toUserFriendlyError(err, providerAuth(provider));
      }
      // Otherwise fall back to a disk-only inventory so a consumer that imported
      // a shared snapshot (no S3 access) still sees the data it has.
      const local = await getLocalDataInventory(ctx.dataDir, provider.name, t);
      if (local.totalLocalPeriods > 0) {
        logger.info('S3 inventory unavailable — using local-only inventory', { tier: t, provider: provider.name });
        return { ...local, provider: provider.name };
      }
      throw toUserFriendlyError(err, providerAuth(provider));
    }
  });

  ipcMain.handle('data:delete-period', async (_event, period: string, tier: ExpectedDataType = 'daily', providerName?: string): Promise<void> => {
    const config = await getConfig();
    const provider = resolveProvider(config.providers, providerName);
    await deleteLocalPeriodFiles(ctx.dataDir, provider.name, period, tier);
    // The RollupStore is bound to the FIRST provider — cascade only its daily
    // deletes; other providers' queries read raw.
    if (tier === 'daily' && provider.name === config.providers[0]?.name) {
      await cascadeRollupForDeletedMonth(app, period.slice(0, 7));
    }
  });

  // Manual prune: drop every local period that has fallen outside its tier's
  // retention window, across ALL configured providers × their configured tiers
  // (the same providers × configuredTierRetentions loop as the auto-prune pass
  // and the auto-sync download cutoff, so the three can't drift). Local-only —
  // derives the on-disk period list from getLocalDataInventory, so it works
  // without any S3 access. Returns what was removed so the UI can report it.
  ipcMain.handle('data:prune', async (): Promise<PruneResult> => {
    const config = await getConfig();
    const first = config.providers[0];
    if (first === undefined) throw new Error('No provider configured');

    const deleted: { tier: DataTier; period: string; provider: string }[] = [];
    for (const provider of config.providers) {
      for (const { tier, retentionDays } of configuredTierRetentions(provider.sync)) {
        const local = await getLocalDataInventory(ctx.dataDir, provider.name, tier);
        const expired = periodsOutsideRetention(local.local.periods, retentionDays);
        for (const period of expired) {
          const removed = await deleteLocalPeriodFiles(ctx.dataDir, provider.name, period, tier);
          if (removed) deleted.push({ tier, period, provider: provider.name });
        }
      }
    }
    // Cascade the prune into the rollup, once per unique daily month removed —
    // FIRST provider only (the RollupStore is bound to it; other providers'
    // queries read raw).
    const firstDailyMonths = deleted
      .filter(d => d.provider === first.name && d.tier === 'daily')
      .map(d => d.period);
    for (const month of changedRollupMonths(firstDailyMonths)) {
      await cascadeRollupForDeletedMonth(app, month);
    }
    if (deleted.length > 0) {
      logger.info(`Prune: removed ${String(deleted.length)} period(s) outside retention`);
      recordSyncLog('info', `Prune: removed ${String(deleted.length)} period(s) outside retention`);
    }
    return { deleted };
  });

  ipcMain.handle('data:sync-periods', async (_event, fileEntries: ManifestFileEntry[], syncId: string = 'default'): Promise<{ filesDownloaded: number; rowsProcessed: number }> => {
    const config = await getConfig();
    const { provider, tier, key } = resolveSyncId(syncId, config.providers);

    // Coalesce with an already-running sync of this exact provider/tier. Without
    // this a manual "Sync now" racing the auto-sync scheduler (which fires
    // immediately after an SSO/gcloud re-login) launched a second download; for
    // GCP the two shared staging/install state and could install a partial
    // month stamped complete. The SyncClient enforces the same rule airtightly;
    // this is the fast, quiet path so the UI never sees a spurious error.
    if (state.syncStatuses[key]?.status === 'syncing') {
      recordSyncLog('info', `Sync '${key}' already in progress; ignoring duplicate request`);
      return { filesDownloaded: 0, rowsProcessed: 0 };
    }

    const bucketPath = resolveBucketPath(provider, tier);
    state.syncStatuses[key] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: fileEntries.length, filesDone: 0, bytesTotal: 0, bytesDone: 0, message: '' };

    recordSyncLog('info', `Sync started: ${provider.name}/${tier} (${String(fileEntries.length)} file(s))`);

    try {
      const result = await traceSpan(
        {
          name: 'sync.s3',
          op: SPAN_OP.sync,
          forceTransaction: true,
          attributes: { 'sync.tier': tier, 'sync.provider': provider.name, 'sync.files_requested': fileEntries.length },
        },
        async (span) => {
          const r = await ctx.syncClient.syncPeriods({
            bucketPath,
            auth: providerAuth(provider),
            providerName: provider.name,
            dataDir: ctx.dataDir,
            tier,
            files: fileEntries,
            syncKey: key,
            onProgress: syncProgressReporter(state, key),
          });
          span?.setAttribute('sync.files_downloaded', r.filesDownloaded);
          span?.setAttribute('sync.rows_processed', r.rowsProcessed);
          return r;
        },
      );

      const now = new Date();
      state.syncStatuses[key] = { status: 'completed', lastSync: now, filesDownloaded: result.filesDownloaded };
      // Best-effort: the persisted timestamp is cosmetic and self-heals on the
      // next sync, so a write failure must never fail the (successful) sync.
      await writeTierLastSync(ctx.dataDir, provider.name, tier, now.toISOString()).catch(() => { /* cosmetic */ });
      if (result.filesDownloaded > 0) {
        if (tier === 'daily') {
          if (provider.name === config.providers[0]?.name) {
            // Re-roll only the daily partitions this sync touched (file replace).
            // FIRST provider only — the RollupStore is bound to its tree; other
            // providers' daily data is queried raw.
            app.maintainRollup(changedRollupMonths(fileEntries.map(e => extractPeriod(e.key))));
          } else {
            app.warmupBase();
          }
          // Then re-discover + recompute baselines against the refreshed data —
          // baselines read ALL providers, so every daily sync recomputes.
          app.recomputeBaselines();
        } else {
          // Hourly / cost-opt don't feed the daily rollup; just refresh caches.
          app.warmupBase();
        }
      }
      return result;
    } catch (err: unknown) {
      // Backstop: the SyncClient rejects a duplicate start airtightly (the
      // handler's own status check can lose a same-tick race). Treat it as the
      // coalesced no-op it is, and leave the in-flight sync's status untouched.
      if (err instanceof Error && err.message === SYNC_ALREADY_RUNNING) {
        recordSyncLog('info', `Sync '${key}' already in progress; ignoring duplicate request`);
        return { filesDownloaded: 0, rowsProcessed: 0 };
      }
      const error = handleSyncError(err, key, providerAuth(provider), state);
      if (error.message === 'Download cancelled') {
        return { filesDownloaded: 0, rowsProcessed: 0 };
      }
      throw error;
    }
  });

  ipcMain.handle('data:cancel-sync', async (_event, syncId: string = 'default'): Promise<void> => {
    const config = await getConfig().catch(() => null);
    const providers = config?.providers ?? [];
    if (providers.length === 0) return; // nothing configured → nothing running
    const { key } = resolveSyncId(syncId, providers);
    // Cancel by the same {provider}:{tier} key the sync was started under. The
    // SyncClient owns the mapping to the live worker request id, so this always
    // targets the right download (or no-ops when nothing is running for the
    // key) — the old handler-local counter drifted from the worker's id
    // whenever auto-sync ran and aborted the wrong sync or none.
    ctx.syncClient.cancelSync(key);
    if (state.syncStatuses[key]?.status === 'syncing') {
      logger.info(`Sync '${key}' cancelled by user`);
      recordSyncLog('warn', `Sync '${key}' cancelled by user`);
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

  // Sibling channel rather than an extra argument on `data:sso-login`: that
  // handler's `(profile: string)` arity is frozen across CostApi, the preload
  // bridge and the SSO button, and GCP's ADC login takes no profile at all.
  ipcMain.handle('data:gcloud-login', async (_event, rawMode: unknown, rawProvider: unknown): Promise<void> => {
    const { spawn } = await import('node:child_process');
    const { delimiter } = await import('node:path');
    const currentPath = process.env['PATH'] ?? '';
    // Reuses core's own probe list rather than a second hand-written copy:
    // they disagreed on Windows, where `findGcloudCli` looks under
    // PROGRAMFILES/LOCALAPPDATA but this handler relied on bare PATH — so sync
    // found gcloud and the re-auth button did not.
    const fullPath = [...new Set([...currentPath.split(delimiter), ...gcloudSearchPaths()])].join(delimiter);

    const mode: GcloudLoginMode = rawMode === 'cli' ? 'cli' : 'adc';

    // Re-establishing ADC without the impersonation flag would REPLACE a
    // working impersonating credential with a plain-user one — turning the
    // button that exists to fix auth into the thing that breaks it, since the
    // least-privilege recipe grants the bucket only to the service account.
    //
    // Resolved from the provider whose error raised the button, NOT the first
    // one that happens to have impersonation configured: in a two-GCP
    // workspace that stamped provider A's service account onto the
    // machine-wide ADC while the user was trying to fix provider B, leaving B
    // with a 403 no classifier recognises and no button at all.
    const config = await getConfig().catch(() => null);
    const gcpProviders = (config?.providers ?? []).filter(
      (p): p is Extract<ProviderConfig, { type: 'gcp' }> => p.type === 'gcp',
    );
    const named = typeof rawProvider === 'string'
      ? gcpProviders.find(p => String(p.name) === rawProvider)
      : undefined;
    // With no name supplied, only impersonate when it is unambiguous — one GCP
    // provider means there is nothing to pick wrong.
    const target = named ?? (gcpProviders.length === 1 ? gcpProviders[0] : undefined);
    const impersonate = target?.impersonateServiceAccount;

    const loginArgs = mode === 'cli' ? ['auth', 'login'] : ['auth', 'application-default', 'login'];
    // `gcloud auth login` signs in the CLI's own account and takes no
    // impersonation flag — that is a property of the credential ADC mints.
    if (mode === 'adc' && impersonate !== undefined) {
      loginArgs.push(`--impersonate-service-account=${impersonate}`);
    }

    // Windows ships gcloud as `gcloud.cmd`, which Node refuses to spawn without
    // a shell (CVE-2024-27980) — but cmd.exe starts successfully whether or not
    // gcloud exists, so the ENOENT below can never fire there. Probe the disk
    // first, or the "install the Cloud SDK" branch is unreachable on Windows
    // and the button simply spins for its 30-second lock.
    const useShell = process.platform === 'win32';
    if (useShell && !gcloudCliFound()) throw new Error('GCLOUD_CLI_NOT_FOUND');
    const bin = findGcloudCli();

    return new Promise<void>((resolve, reject) => {
      const child = spawn(
        useShell ? `"${bin}"` : bin,
        useShell ? loginArgs.map(a => `"${a}"`) : loginArgs,
        {
          stdio: 'ignore',
          detached: true,
          shell: useShell,
          env: { ...process.env, PATH: fullPath },
        },
      );
      child.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') {
          reject(new Error('GCLOUD_CLI_NOT_FOUND'));
        } else {
          reject(err);
        }
      });
      child.on('spawn', () => {
        child.unref();
        resolve();
      });
      // Mirrors the SSO path: resolve as soon as the browser is opening, then
      // kick a sync once the CLI exits cleanly so data refreshes immediately.
      child.on('exit', (code) => {
        if (code === 0) triggerAutoSyncNow();
      });
    });
  });

  ipcMain.handle('data:account-mapping', async (): Promise<AccountMappingStatus> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const rawDir = path.join(ctx.stateDir, 'raw');
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

/** Folds SyncClient progress events into the renderer-visible status entry
 *  for `statusKey`. */
function syncProgressReporter(state: AppState, statusKey: string): (progress: SyncProgress) => void {
  return (progress) => {
    const bytesDone = progress.bytesDone ?? 0;
    const bytesTotal = progress.bytesTotal ?? 0;
    const fraction = computeSyncFraction(bytesDone, bytesTotal, progress.filesDone, progress.filesTotal);
    state.syncStatuses[statusKey] = {
      status: 'syncing',
      phase: progress.phase === 'repartitioning' ? 'repartitioning' : 'downloading',
      progress: fraction,
      filesTotal: progress.filesTotal,
      filesDone: progress.filesDone,
      bytesTotal,
      bytesDone,
      message: progress.message ?? '',
    };
  };
}

function handleSyncError(
  err: unknown,
  statusKey: string,
  auth: ProviderAuth,
  state: AppState,
): Error {
  const raw = err instanceof Error ? err : new Error(String(err));
  if (raw.message === 'Download cancelled') {
    state.syncStatuses[statusKey] = { status: 'idle', lastSync: null };
    return raw;
  }
  const error = toUserFriendlyError(err, auth);
  logger.error(`Selective sync '${statusKey}' failed: ${error.message}`);
  recordSyncLog('error', `Sync '${statusKey}' failed: ${error.message}`);
  state.syncStatuses[statusKey] = { status: 'failed', error, lastSync: null };
  return error;
}

export { resolveDataType };
