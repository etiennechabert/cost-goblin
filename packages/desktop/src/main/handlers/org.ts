import { ipcMain } from 'electron';
import { isStringRecord, logger } from '@costgoblin/core';
import type { OrgSyncResult, OrgSyncProgress, OrgAccount } from '@costgoblin/core';
import { syncOrgAccounts } from '../aws-org-client.js';
import { syncRegionNames } from '../aws-ssm-client.js';
import type { AppContext } from './context.js';

function isOrgAccount(v: unknown): v is OrgAccount {
  if (!isStringRecord(v)) return false;
  return (
    typeof v['id'] === 'string' &&
    typeof v['name'] === 'string' &&
    typeof v['email'] === 'string' &&
    typeof v['status'] === 'string' &&
    typeof v['joinedTimestamp'] === 'string' &&
    typeof v['ouPath'] === 'string' &&
    isStringRecord(v['tags'])
  );
}

function decodeOrgSyncResult(raw: string): OrgSyncResult | null {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!isStringRecord(parsed)) return null;
  const accounts = parsed['accounts'];
  const orgId = parsed['orgId'];
  const syncedAt = parsed['syncedAt'];
  if (!Array.isArray(accounts) || typeof orgId !== 'string' || typeof syncedAt !== 'string') return null;
  if (!accounts.every(isOrgAccount)) return null;
  return { accounts, orgId, syncedAt };
}

export function registerOrgHandlers(app: AppContext): void {
  const { ctx } = app;
  let orgSyncProgress: OrgSyncProgress | null = null;
  // Latest result of the SSM region-name sync. Lets the UI tell the user why
  // region friendly names didn't populate (typically: missing IAM permission)
  // instead of the silent "not synced" we showed before.
  let lastRegionSyncError: string | null = null;

  async function orgResultPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(path.dirname(ctx.dataDir), 'org-accounts.json');
  }

  ipcMain.handle('org:sync-accounts', async (_event, profile: string): Promise<OrgSyncResult> => {
    orgSyncProgress = { phase: 'accounts', done: 0, total: 0 };
    try {
      const result = await syncOrgAccounts(profile, (p) => { orgSyncProgress = p; });
      const fs = await import('node:fs/promises');
      await fs.writeFile(await orgResultPath(), JSON.stringify(result, null, 2));
      const path = await import('node:path');
      const tagLookup = result.accounts.map(a => ({ id: a.id, tags: a.tags }));
      await fs.writeFile(path.join(path.dirname(ctx.dataDir), 'org-account-tags.json'), JSON.stringify(tagLookup));

      // Piggyback the SSM region-name sync onto the existing org-sync flow.
      // Failures here are non-fatal — region names are a display nicety and
      // the user has already paid the auth cost for the org sync. Capture
      // the error so the UI can hint at the cause (most often: profile
      // lacks ssm:GetParametersByPath).
      orgSyncProgress = { phase: 'regions', done: 0, total: 0 };
      try {
        const regionMap = await syncRegionNames(profile);
        await fs.writeFile(path.join(path.dirname(ctx.dataDir), 'region-names.json'), JSON.stringify(regionMap, null, 2));
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

  ipcMain.handle('org:get-region-names-info', async (): Promise<{ count: number; syncedAt: string; lastError: string | null } | null> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    try {
      const raw = await fs.readFile(path.join(path.dirname(ctx.dataDir), 'region-names.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (!isStringRecord(parsed)) return null;
      const regions = parsed['regions'];
      const syncedAt = parsed['syncedAt'];
      if (!isStringRecord(regions) || typeof syncedAt !== 'string') return null;
      return { count: Object.keys(regions).length, syncedAt, lastError: lastRegionSyncError };
    } catch {
      // No file yet, but we may still know why from the most recent attempt.
      if (lastRegionSyncError !== null) {
        return { count: 0, syncedAt: '', lastError: lastRegionSyncError };
      }
      return null;
    }
  });
}
