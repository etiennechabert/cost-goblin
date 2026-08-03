import { ipcMain } from 'electron';
import { isStringRecord, logger } from '@costgoblin/core';
import type { OrgSyncResult, OrgSyncProgress, ProviderConfig } from '@costgoblin/core';
import { syncOrgAccounts } from '../aws-org-client.js';
import { syncRegionNames } from '../aws-ssm-client.js';
import {
  MERGED_ORG_FILE,
  buildFlatOrgTags,
  clearMergedAndSidecars,
  decodeOrgSyncResult,
  writeProviderOrgResult,
} from '../org-merge.js';
import type { AppContext } from './context.js';

export function registerOrgHandlers(app: AppContext): void {
  const { ctx, invalidateDimensions } = app;
  let orgSyncProgress: OrgSyncProgress | null = null;
  // Latest result of the SSM region-name sync. Lets the UI tell the user why
  // region friendly names didn't populate (typically: missing IAM permission)
  // instead of the silent "not synced" we showed before.
  let lastRegionSyncError: string | null = null;

  async function orgResultPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(ctx.stateDir, MERGED_ORG_FILE);
  }

  /** The provider this sync targets: exact name lookup when the renderer
   *  names one (unknown name → throw), else the FIRST configured provider,
   *  else null (mid-onboarding, no config / empty providers). */
  async function resolveProvider(providerName: string | undefined): Promise<{
    provider: ProviderConfig | null;
    firstProviderName: string | null;
  }> {
    const config = await app.getConfig().catch(() => null);
    const providers = config?.providers ?? [];
    const first = providers[0] ?? null;
    if (providerName === undefined) {
      return { provider: first, firstProviderName: first === null ? null : String(first.name) };
    }
    const provider = providers.find(p => String(p.name) === providerName) ?? null;
    if (provider === null) throw new Error(`Unknown provider "${providerName}"`);
    return { provider, firstProviderName: first === null ? null : String(first.name) };
  }

  ipcMain.handle('org:sync-accounts', async (_event, profile: string, providerName?: string): Promise<OrgSyncResult> => {
    const { provider, firstProviderName } = await resolveProvider(providerName);
    orgSyncProgress = { phase: 'accounts', done: 0, total: 0 };
    try {
      const result = await syncOrgAccounts(profile, (p) => { orgSyncProgress = p; });
      const fs = await import('node:fs/promises');
      const path = await import('node:path');

      // Per-provider sidecar + merged view (#516). While no provider is
      // configured yet (mid-onboarding) fall back to the legacy single-file
      // write — the first per-provider sync adopts it as a sidecar later.
      let flatSource: OrgSyncResult = result;
      if (provider === null || firstProviderName === null) {
        await fs.writeFile(await orgResultPath(), JSON.stringify(result, null, 2));
      } else {
        flatSource = await writeProviderOrgResult(
          ctx.stateDir, String(provider.name), firstProviderName, result,
        );
      }
      // Flat account→tags lookup regenerates from the MERGED accounts after
      // every merge, so the account-tag fallback covers all providers.
      await fs.writeFile(path.join(ctx.stateDir, 'org-account-tags.json'), buildFlatOrgTags(flatSource.accounts));

      // Piggyback the SSM region-name sync onto the existing org-sync flow.
      // Failures here are non-fatal — region names are a display nicety and
      // the user has already paid the auth cost for the org sync. Capture
      // the error so the UI can hint at the cause (most often: profile
      // lacks ssm:GetParametersByPath). Region data is global — one file,
      // whichever provider synced last wins.
      orgSyncProgress = { phase: 'regions', done: 0, total: 0 };
      try {
        const regionMap = await syncRegionNames(profile);
        await fs.writeFile(path.join(ctx.stateDir, 'region-names.json'), JSON.stringify(regionMap, null, 2));
        lastRegionSyncError = null;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.info(`Region-name sync failed (non-fatal): ${msg}`);
        lastRegionSyncError = msg;
      }

      orgSyncProgress = null;
      return result;
    } catch (err: unknown) {
      orgSyncProgress = null;
      throw err;
    }
  });

  ipcMain.handle('org:get-result', async (): Promise<OrgSyncResult | null> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await orgResultPath(), 'utf-8');
      return decodeOrgSyncResult(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle('org:get-progress', (): OrgSyncProgress | null => {
    return orgSyncProgress;
  });

  // Standalone SSM resync — same syncRegionNames(), same destination file,
  // but doesn't drag the org sync along. Lets the user fix a transient SSM
  // failure (perm denied, network blip) without redoing the slow per-account
  // tag fetch loop. lastRegionSyncError mirrors the merged sync's tracking.
  ipcMain.handle('ssm:sync-region-names', async (_event, profile: string): Promise<{ count: number; syncedAt: string }> => {
    orgSyncProgress = { phase: 'regions', done: 0, total: 0 };
    try {
      const regionMap = await syncRegionNames(profile);
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      await fs.writeFile(path.join(ctx.stateDir, 'region-names.json'), JSON.stringify(regionMap, null, 2));
      lastRegionSyncError = null;
      invalidateDimensions();
      orgSyncProgress = null;
      return { count: Object.keys(regionMap.regions).length, syncedAt: regionMap.syncedAt };
    } catch (err: unknown) {
      orgSyncProgress = null;
      const msg = err instanceof Error ? err.message : String(err);
      lastRegionSyncError = msg;
      throw err;
    }
  });

  ipcMain.handle('org:clear-data', async (): Promise<void> => {
    // Wipes everything the org sync produced — the merged accounts file plus
    // every per-provider sidecar, the flat tag lookup used for resource-tag
    // fallback, and the SSM region-name cache. ENOENT is swallowed so the
    // call is idempotent (clicking twice doesn't error). The next sync
    // re-creates whichever files succeed.
    const orgFiles = await clearMergedAndSidecars(ctx.stateDir);
    for (const f of orgFiles.deleted) logger.info(`Cleared ${f}`);
    for (const f of orgFiles.failed) logger.info(`Failed to clear ${f.file}: ${f.message}`);
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    for (const f of ['org-account-tags.json', 'region-names.json']) {
      try {
        await fs.unlink(path.join(ctx.stateDir, f));
        logger.info(`Cleared ${f}`);
      } catch (err: unknown) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
        if (code !== 'ENOENT') logger.info(`Failed to clear ${f}: ${String(err)}`);
      }
    }
    lastRegionSyncError = null;
    // Drop the cached id→name + region maps so subsequent queries re-load
    // (they'll find nothing and treat all values as raw).
    invalidateDimensions();
  });

  ipcMain.handle('org:get-region-names-info', async (): Promise<{ count: number; syncedAt: string; lastError: string | null; regions: Record<string, { longName: string; country: string; continent: string }> } | null> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      const raw = await fs.readFile(path.join(ctx.stateDir, 'region-names.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isStringRecord(parsed)) return null;
      const regions = parsed['regions'];
      const syncedAt = parsed['syncedAt'];
      if (!isStringRecord(regions) || typeof syncedAt !== 'string') return null;
      const out: Record<string, { longName: string; country: string; continent: string }> = {};
      for (const [code, info] of Object.entries(regions)) {
        if (!isStringRecord(info)) continue;
        const longName = info['longName'];
        if (typeof longName !== 'string' || longName.length === 0) continue;
        const country = typeof info['country'] === 'string' ? info['country'] : '';
        const continent = typeof info['continent'] === 'string' ? info['continent'] : '';
        out[code] = { longName, country, continent };
      }
      return { count: Object.keys(out).length, syncedAt, lastError: lastRegionSyncError, regions: out };
    } catch {
      // No file yet, but we may still know why from the most recent attempt.
      if (lastRegionSyncError !== null) {
        return { count: 0, syncedAt: '', lastError: lastRegionSyncError, regions: {} };
      }
      return null;
    }
  });
}
