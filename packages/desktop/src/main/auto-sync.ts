import { logger, parseJsonObject, configuredTierRetentions, periodsOutsideRetention, retentionCutoffPeriod, isCredentialError } from '@costgoblin/core';
import type { AutoSyncStatus, SyncLogLevel } from '@costgoblin/core';
import { updatePrefsFile } from './handlers/prefs-file.js';

export interface AutoSyncDeps {
  /** Optional sink for the Data & Sync activity log. The actual downloads
   *  stream through the sync worker already; this surfaces the local-only
   *  breadcrumbs (checking / nothing-to-sync / prune) that never hit it. */
  onLog?: (level: SyncLogLevel, message: string) => void;
  getPrefsPath: () => Promise<string>;
  getConfig: () => Promise<{ providers: { sync: {
    daily: { retentionDays?: number | undefined };
    hourly?: { retentionDays?: number | undefined } | undefined;
    costOptimization?: { retentionDays?: number | undefined } | undefined;
  } }[] }>;
  getInventory: (tier: string) => Promise<{ periods: { period: string; localStatus: string; files: { key: string; contentHash: string; size: number }[] }[] }>;
  syncPeriods: (files: { key: string; contentHash: string; size: number }[], tier: string) => Promise<{ filesDownloaded: number }>;
  /** On-disk billing periods (YYYY-MM) for a tier — drives the auto-prune pass. */
  getLocalPeriods: (tier: string) => Promise<string[]>;
  /** Delete the given local periods for a tier (auto-prune). */
  deletePeriods: (periods: readonly string[], tier: string) => Promise<void>;
}

let status: AutoSyncStatus = { state: 'disabled' };
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
// Captured by startAutoSync so an out-of-band trigger (e.g. right after the
// user restores credentials via SSO login) can run a pass immediately instead
// of waiting up to a full interval for the next scheduled run.
let lastDeps: AutoSyncDeps | null = null;
// Captured so `runOnce` can report the correct nextRun without needing
// to know the scheduler's interval — `startAutoSync` refreshes this on
// every (re)start.
let currentIntervalMs = 24 * 60 * 60 * 1000;

/** Minimum / maximum interval the UI can request. Anything sub-hour risks
 *  hammering S3 for a typical multi-tier sync and the upper bound (one month)
 *  is the slowest cadence the UI offers ("Monthly"). */
export const MIN_AUTO_SYNC_INTERVAL_MINUTES = 60;
export const MAX_AUTO_SYNC_INTERVAL_MINUTES = 31 * 24 * 60;
export const DEFAULT_AUTO_SYNC_INTERVAL_MINUTES = 24 * 60;

export function getAutoSyncStatus(): AutoSyncStatus {
  return status;
}

export async function readAutoSyncEnabled(prefsPath: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    return parseJsonObject(raw)?.['autoSync'] === true;
  } catch {
    // file doesn't exist
  }
  return false;
}

export async function writeAutoSyncEnabled(prefsPath: string, enabled: boolean): Promise<void> {
  await updatePrefsFile(prefsPath, (current) => ({ ...current, autoSync: enabled }));
}

export async function readAutoPruneEnabled(prefsPath: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    return parseJsonObject(raw)?.['autoPrune'] === true;
  } catch {
    // file doesn't exist
  }
  return false;
}

export async function writeAutoPruneEnabled(prefsPath: string, enabled: boolean): Promise<void> {
  await updatePrefsFile(prefsPath, (current) => ({ ...current, autoPrune: enabled }));
}

export async function readAutoSyncIntervalMinutes(prefsPath: string): Promise<number> {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    const value = parseJsonObject(raw)?.['autoSyncIntervalMinutes'];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return clampInterval(value);
    }
  } catch {
    // file doesn't exist
  }
  return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
}

export async function writeAutoSyncIntervalMinutes(prefsPath: string, minutes: number): Promise<void> {
  await updatePrefsFile(prefsPath, (current) => ({ ...current, autoSyncIntervalMinutes: clampInterval(minutes) }));
}

function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
  return Math.max(MIN_AUTO_SYNC_INTERVAL_MINUTES, Math.min(MAX_AUTO_SYNC_INTERVAL_MINUTES, Math.round(minutes)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Log a scheduler breadcrumb: keep the existing stdout line (always info, as
// before) and additionally feed the Data & Sync activity log at the given
// level so failures stand out there.
function note(deps: AutoSyncDeps, level: SyncLogLevel, message: string): void {
  logger.info(message);
  deps.onLog?.(level, message);
}

async function syncTier(
  deps: AutoSyncDeps,
  tier: { name: string; retention: number },
): Promise<'ok' | 'skip' | 'error'> {
  const cutoff = retentionCutoffPeriod(tier.retention);
  let inventory: Awaited<ReturnType<typeof deps.getInventory>>;
  try {
    inventory = await deps.getInventory(tier.name);
  } catch (err: unknown) {
    // Credentials expired/invalid is a real failure worth surfacing — set the
    // error status so the toolbar flags that background sync is blocked. Other
    // (transient) inventory failures stay a silent skip as before.
    if (isCredentialError(err)) {
      note(deps, 'warn', `Auto-sync: ${tier.name} inventory failed (credentials) — ${errorMessage(err)}`);
      status = { state: 'error', message: errorMessage(err), lastRun: new Date().toISOString() };
      return 'error';
    }
    note(deps, 'warn', `Auto-sync: failed to get ${tier.name} inventory — ${errorMessage(err)}`);
    return 'skip';
  }

  const missing = inventory.periods
    .filter(p => (p.localStatus === 'missing' || p.localStatus === 'stale') && p.period >= cutoff);

  if (missing.length === 0) {
    note(deps, 'info', `Auto-sync: ${tier.name} — nothing to sync`);
    return 'skip';
  }

  const files = missing.flatMap(p => [...p.files]);
  note(deps, 'info', `Auto-sync: ${tier.name} — syncing ${String(missing.length)} periods (${String(files.length)} files)`);
  status = { state: 'syncing', tier: tier.name, filesDone: 0, filesTotal: files.length };

  try {
    const result = await deps.syncPeriods(files, tier.name);
    note(deps, 'info', `Auto-sync: ${tier.name} — synced ${String(result.filesDownloaded)} files`);
    return 'ok';
  } catch (err: unknown) {
    note(deps, 'warn', `Auto-sync: ${tier.name} — sync failed: ${errorMessage(err)}`);
    status = { state: 'error', message: errorMessage(err), lastRun: new Date().toISOString() };
    return 'error';
  }
}

/** Delete out-of-retention local data for every configured tier. Local-only
 *  and best-effort: per-tier read/delete failures are logged and skipped so one
 *  bad tier never aborts the whole pass. */
async function prunePass(
  deps: AutoSyncDeps,
  provider: { sync: Parameters<typeof configuredTierRetentions>[0] },
): Promise<void> {
  for (const { tier, retentionDays } of configuredTierRetentions(provider.sync)) {
    let local: string[];
    try {
      local = await deps.getLocalPeriods(tier);
    } catch (err: unknown) {
      note(deps, 'warn', `Auto-prune: failed to read ${tier} local data — ${errorMessage(err)}`);
      continue;
    }
    const expired = periodsOutsideRetention(local, retentionDays);
    if (expired.length === 0) continue;
    note(deps, 'info', `Auto-prune: ${tier} — removing ${String(expired.length)} period(s) outside ${String(retentionDays)}d retention: ${expired.join(', ')}`);
    try {
      await deps.deletePeriods(expired, tier);
    } catch (err: unknown) {
      note(deps, 'warn', `Auto-prune: ${tier} — delete failed: ${errorMessage(err)}`);
    }
  }
}

async function runOnce(deps: AutoSyncDeps): Promise<void> {
  if (running) return;
  running = true;

  try {
    const prefsPath = await deps.getPrefsPath();
    const syncEnabled = await readAutoSyncEnabled(prefsPath);
    const pruneEnabled = await readAutoPruneEnabled(prefsPath);
    if (!syncEnabled && !pruneEnabled) {
      status = { state: 'disabled' };
      running = false;
      return;
    }

    status = { state: 'checking' };
    note(deps, 'info', 'Auto-sync: checking');

    const config = await deps.getConfig();
    const provider = config.providers[0];
    if (provider === undefined) {
      status = { state: 'idle', lastRun: new Date().toISOString(), nextRun: null };
      running = false;
      return;
    }

    // Prune first — it's local-only, so it still frees space even when S3 is
    // unreachable and the download pass below would fail.
    if (pruneEnabled) {
      await prunePass(deps, provider);
    }

    if (syncEnabled) {
      // Same tier+retention set as the auto-prune pass so sync and prune stay in
      // lockstep — this is what pulls cost-optimization too, which the old
      // hand-rolled daily+hourly list silently skipped (leaving it "Never").
      const tiers = configuredTierRetentions(provider.sync)
        .map(t => ({ name: t.tier, retention: t.retentionDays }));

      for (const tier of tiers) {
        const tierResult = await syncTier(deps, tier);
        if (tierResult === 'error') {
          running = false;
          return;
        }
      }
    }

    const now = new Date().toISOString();
    status = { state: 'idle', lastRun: now, nextRun: new Date(Date.now() + currentIntervalMs).toISOString() };
  } catch (err: unknown) {
    status = { state: 'error', message: errorMessage(err), lastRun: new Date().toISOString() };
  }

  running = false;
}

/** Run a sync/prune pass right now, out of band, reusing the scheduler's
 *  captured deps — used to recover promptly after the user restores credentials
 *  (SSO login) instead of waiting up to a full interval. No-op if the scheduler
 *  was never started or a run is already in flight; runOnce still gates on the
 *  auto-sync / auto-prune enabled flags, so a disabled scheduler does nothing. */
export function triggerAutoSyncNow(): void {
  if (lastDeps === null || running) return;
  logger.info('Auto-sync: out-of-band run requested (credential recovery)');
  void runOnce(lastDeps);
}

export function startAutoSync(deps: AutoSyncDeps, intervalMinutes: number): void {
  stopAutoSync();

  lastDeps = deps;
  const clamped = clampInterval(intervalMinutes);
  currentIntervalMs = clamped * 60 * 1000;

  // initial run after short delay (let the app finish loading)
  timer = setTimeout(() => {
    void runOnce(deps).then(() => {
      // schedule recurring
      timer = setInterval(() => { void runOnce(deps); }, currentIntervalMs);
    });
  }, 5000);

  logger.info(`Auto-sync: scheduled every ${String(clamped)} minutes`);
}

export function stopAutoSync(): void {
  if (timer !== null) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
  status = { state: 'disabled' };
}
