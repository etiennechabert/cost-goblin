import { logger, parseJsonObject, configuredTierRetentions, periodsOutsideRetention, retentionCutoffPeriod, isCredentialError, isGcpCredentialError } from '@costgoblin/core';
import type { AutoSyncStatus, ProviderSyncError, SyncLogLevel } from '@costgoblin/core';
import { updatePrefsFile } from './handlers/prefs-file.js';

/** Structural view of one configured provider — just enough for the scheduler
 *  (identity + per-tier retention). The dep closures resolve the rest
 *  (credentials, buckets) from the full config by name on every call, so
 *  config edits between passes are picked up. */
export interface AutoSyncProvider {
  readonly name: string;
  readonly sync: {
    readonly daily: { readonly retentionDays?: number | undefined };
    readonly hourly?: { readonly retentionDays?: number | undefined } | undefined;
    readonly costOptimization?: { readonly retentionDays?: number | undefined } | undefined;
  };
}

export interface AutoSyncDeps {
  /** Optional sink for the Data & Sync activity log. The actual downloads
   *  stream through the sync worker already; this surfaces the local-only
   *  breadcrumbs (checking / nothing-to-sync / prune) that never hit it. */
  onLog?: (level: SyncLogLevel, message: string) => void;
  getPrefsPath: () => Promise<string>;
  /** All configured providers, in config order — synced sequentially. */
  getConfig: () => Promise<{ providers: readonly AutoSyncProvider[] }>;
  getInventory: (providerName: string, tier: string) => Promise<{ periods: { period: string; localStatus: string; files: { key: string; contentHash: string; size: number }[] }[] }>;
  syncPeriods: (providerName: string, files: { key: string; contentHash: string; size: number }[], tier: string) => Promise<{ filesDownloaded: number }>;
  /** On-disk billing periods (YYYY-MM) for a provider's tier — drives the auto-prune pass. */
  getLocalPeriods: (providerName: string, tier: string) => Promise<string[]>;
  /** Delete the given local periods for a provider's tier (auto-prune). */
  deletePeriods: (providerName: string, periods: readonly string[], tier: string) => Promise<void>;
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

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Log a scheduler breadcrumb: keep the existing stdout line (always info, as
// before) and additionally feed the Data & Sync activity log at the given
// level so failures stand out there.
function note(deps: AutoSyncDeps, level: SyncLogLevel, message: string): void {
  logger.info(message);
  deps.onLog?.(level, message);
}

/** Sync one tier of one provider. Returns 'ok' | 'skip'; THROWS on a hard
 *  failure (credential-blocked inventory or a failed download) so runOnce can
 *  record a ProviderSyncError for this provider and move on to the next one.
 *  Transient inventory failures stay a silent skip as before. */
async function syncTier(
  deps: AutoSyncDeps,
  providerName: string,
  tier: { name: string; retention: number },
): Promise<'ok' | 'skip'> {
  const cutoff = retentionCutoffPeriod(tier.retention);
  let inventory: Awaited<ReturnType<typeof deps.getInventory>>;
  try {
    inventory = await deps.getInventory(providerName, tier.name);
  } catch (err: unknown) {
    // Credentials expired/invalid is a real failure worth surfacing — throw so
    // the pass records it against this provider and the toolbar flags that its
    // background sync is blocked. Other (transient) inventory failures stay a
    // silent skip as before.
    //
    // Both arms are tested because this scheduler is provider-agnostic: the
    // AWS-only predicate would silently downgrade a GCP credential expiry to a
    // skip, leaving background sync permanently blocked while the toolbar
    // reported idle.
    if (isCredentialError(err) || isGcpCredentialError(err)) {
      note(deps, 'warn', `Auto-sync: ${providerName}/${tier.name} inventory failed (credentials) — ${errorMessage(err)}`);
      throw asError(err);
    }
    note(deps, 'warn', `Auto-sync: failed to get ${providerName}/${tier.name} inventory — ${errorMessage(err)}`);
    return 'skip';
  }

  const missing = inventory.periods
    .filter(p => (p.localStatus === 'missing' || p.localStatus === 'stale') && p.period >= cutoff);

  if (missing.length === 0) {
    note(deps, 'info', `Auto-sync: ${providerName}/${tier.name} — nothing to sync`);
    return 'skip';
  }

  const files = missing.flatMap(p => [...p.files]);
  note(deps, 'info', `Auto-sync: ${providerName}/${tier.name} — syncing ${String(missing.length)} periods (${String(files.length)} files)`);
  status = { state: 'syncing', tier: tier.name, filesDone: 0, filesTotal: files.length, provider: providerName };

  try {
    const result = await deps.syncPeriods(providerName, files, tier.name);
    note(deps, 'info', `Auto-sync: ${providerName}/${tier.name} — synced ${String(result.filesDownloaded)} files`);
    return 'ok';
  } catch (err: unknown) {
    note(deps, 'warn', `Auto-sync: ${providerName}/${tier.name} — sync failed: ${errorMessage(err)}`);
    throw asError(err);
  }
}

/** Delete one provider's out-of-retention local data for every configured
 *  tier. Local-only and best-effort: per-tier read/delete failures are logged
 *  and skipped so one bad tier never aborts the whole pass. */
async function prunePass(deps: AutoSyncDeps, provider: AutoSyncProvider): Promise<void> {
  for (const { tier, retentionDays } of configuredTierRetentions(provider.sync)) {
    let local: string[];
    try {
      local = await deps.getLocalPeriods(provider.name, tier);
    } catch (err: unknown) {
      note(deps, 'warn', `Auto-prune: failed to read ${provider.name}/${tier} local data — ${errorMessage(err)}`);
      continue;
    }
    const expired = periodsOutsideRetention(local, retentionDays);
    if (expired.length === 0) continue;
    note(deps, 'info', `Auto-prune: ${provider.name}/${tier} — removing ${String(expired.length)} period(s) outside ${String(retentionDays)}d retention: ${expired.join(', ')}`);
    try {
      await deps.deletePeriods(provider.name, expired, tier);
    } catch (err: unknown) {
      note(deps, 'warn', `Auto-prune: ${provider.name}/${tier} — delete failed: ${errorMessage(err)}`);
    }
  }
}

/** One full scheduler pass over every configured provider, sequentially
 *  (bandwidth / rate-limit safety). One provider's failure must never abort or
 *  hide another provider's sync: each provider's tier loop is isolated, its
 *  failure collected as a ProviderSyncError, and the pass keeps going. All
 *  providers failed → 'error'; some failed → 'idle' with providerErrors.
 *  Exported for unit tests — production goes through startAutoSync /
 *  triggerAutoSyncNow. */
export async function runOnce(deps: AutoSyncDeps): Promise<void> {
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
    if (config.providers.length === 0) {
      status = { state: 'idle', lastRun: new Date().toISOString(), nextRun: null };
      running = false;
      return;
    }

    // Prune first — it's local-only, so it still frees space even when S3 is
    // unreachable and the download pass below would fail. Same providers ×
    // configuredTierRetentions loop as the download pass and manual data:prune
    // so the three retention consumers can't drift.
    if (pruneEnabled) {
      for (const provider of config.providers) {
        status = { state: 'checking', provider: provider.name };
        await prunePass(deps, provider);
      }
    }

    const providerErrors: ProviderSyncError[] = [];
    if (syncEnabled) {
      for (const provider of config.providers) {
        status = { state: 'checking', provider: provider.name };
        // Same tier+retention set as the auto-prune pass so sync and prune stay
        // in lockstep — this is what pulls cost-optimization too, which the old
        // hand-rolled daily+hourly list silently skipped (leaving it "Never").
        const tiers = configuredTierRetentions(provider.sync)
          .map(t => ({ name: t.tier, retention: t.retentionDays }));
        try {
          for (const tier of tiers) {
            await syncTier(deps, provider.name, tier);
          }
        } catch (err: unknown) {
          providerErrors.push({ provider: provider.name, message: errorMessage(err) });
        }
      }
    }

    const now = new Date().toISOString();
    const nextRun = new Date(Date.now() + currentIntervalMs).toISOString();
    const firstError = providerErrors[0];
    if (firstError !== undefined && providerErrors.length === config.providers.length) {
      // Every provider failed — the whole pass is blocked.
      status = { state: 'error', message: firstError.message, lastRun: now, providerErrors };
    } else if (firstError !== undefined) {
      status = { state: 'idle', lastRun: now, nextRun, providerErrors };
    } else {
      status = { state: 'idle', lastRun: now, nextRun };
    }
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
