import { logger, parseJsonObject } from '@costgoblin/core';
import type { AutoSyncStatus } from '@costgoblin/core';

export interface AutoSyncDeps {
  getPrefsPath: () => Promise<string>;
  getConfig: () => Promise<{ providers: { sync: { daily: { retentionDays?: number | undefined }; hourly?: { retentionDays?: number | undefined } | undefined } }[] }>;
  getInventory: (tier: string) => Promise<{ periods: { period: string; localStatus: string; files: { key: string; contentHash: string; size: number }[] }[] }>;
  syncPeriods: (files: { key: string; contentHash: string; size: number }[], tier: string) => Promise<{ filesDownloaded: number }>;
}

let status: AutoSyncStatus = { state: 'disabled' };
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
// Captured so `runOnce` can report the correct nextRun without needing
// to know the scheduler's interval — `startAutoSync` refreshes this on
// every (re)start.
let currentIntervalMs = 24 * 60 * 60 * 1000;

/** Minimum / maximum interval the UI can request. Anything sub-hour risks
 *  hammering S3 for a typical multi-tier sync and anything beyond a week
 *  stops feeling like "auto" to the user. */
export const MIN_AUTO_SYNC_INTERVAL_MINUTES = 60;
export const MAX_AUTO_SYNC_INTERVAL_MINUTES = 7 * 24 * 60;
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
  const fs = await import('node:fs/promises');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    const parsed = parseJsonObject(raw);
    if (parsed !== null) {
      existing = { ...parsed };
    }
  } catch { /* */ }
  existing['autoSync'] = enabled;
  await fs.writeFile(prefsPath, JSON.stringify(existing, null, 2));
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
  const fs = await import('node:fs/promises');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    const parsed = parseJsonObject(raw);
    if (parsed !== null) {
      existing = { ...parsed };
    }
  } catch { /* */ }
  existing['autoSyncIntervalMinutes'] = clampInterval(minutes);
  await fs.writeFile(prefsPath, JSON.stringify(existing, null, 2));
}

function clampInterval(minutes: number): number {
  if (!Number.isFinite(minutes)) return DEFAULT_AUTO_SYNC_INTERVAL_MINUTES;
  return Math.max(MIN_AUTO_SYNC_INTERVAL_MINUTES, Math.min(MAX_AUTO_SYNC_INTERVAL_MINUTES, Math.round(minutes)));
}

function retentionCutoff(days: number): string {
  const d = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function runOnce(deps: AutoSyncDeps): Promise<void> {
  if (running) return;
  running = true;

  try {
    const prefsPath = await deps.getPrefsPath();
    const enabled = await readAutoSyncEnabled(prefsPath);
    if (!enabled) {
      status = { state: 'disabled' };
      running = false;
      return;
    }

    status = { state: 'checking' };
    logger.info('Auto-sync: checking for missing data');

    const config = await deps.getConfig();
    const provider = config.providers[0];
    if (provider === undefined) {
      status = { state: 'idle', lastRun: new Date().toISOString(), nextRun: null };
      running = false;
      return;
    }

    const tiers: { name: string; retention: number }[] = [
      { name: 'daily', retention: provider.sync.daily.retentionDays ?? 365 },
    ];
    if (provider.sync.hourly !== undefined) {
      tiers.push({ name: 'hourly', retention: provider.sync.hourly.retentionDays ?? 30 });
    }

    for (const tier of tiers) {
      const cutoff = retentionCutoff(tier.retention);
      let inventory: Awaited<ReturnType<typeof deps.getInventory>>;
      try {
        inventory = await deps.getInventory(tier.name);
      } catch (err: unknown) {
        logger.info(`Auto-sync: failed to get ${tier.name} inventory — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const missing = inventory.periods
        .filter(p => (p.localStatus === 'missing' || p.localStatus === 'stale') && p.period >= cutoff);

      if (missing.length === 0) {
        logger.info(`Auto-sync: ${tier.name} — nothing to sync`);
        continue;
      }

      const files = missing.flatMap(p => [...p.files]);
      logger.info(`Auto-sync: ${tier.name} — syncing ${String(missing.length)} periods (${String(files.length)} files)`);

      status = { state: 'syncing', tier: tier.name, filesDone: 0, filesTotal: files.length };

      try {
        const result = await deps.syncPeriods(files, tier.name);
        logger.info(`Auto-sync: ${tier.name} — synced ${String(result.filesDownloaded)} files`);
      } catch (err: unknown) {
        logger.info(`Auto-sync: ${tier.name} — sync failed: ${err instanceof Error ? err.message : String(err)}`);
        status = { state: 'error', message: err instanceof Error ? err.message : String(err), lastRun: new Date().toISOString() };
        running = false;
        return;
      }
    }

    const now = new Date().toISOString();
    status = { state: 'idle', lastRun: now, nextRun: new Date(Date.now() + currentIntervalMs).toISOString() };
  } catch (err: unknown) {
    status = { state: 'error', message: err instanceof Error ? err.message : String(err), lastRun: new Date().toISOString() };
  }

  running = false;
}

export function startAutoSync(deps: AutoSyncDeps, intervalMinutes: number): void {
  stopAutoSync();

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
