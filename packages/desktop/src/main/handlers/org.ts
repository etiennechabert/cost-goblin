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
      // the user has already paid the auth cost for the org sync.
      try {
        const regionMap = await syncRegionNames(profile);
        await fs.writeFile(path.join(path.dirname(ctx.dataDir), 'region-names.json'), JSON.stringify(regionMap, null, 2));
      } catch (err: unknown) {
        logger.info(`Region-name sync failed (non-fatal): ${String(err)}`);
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
}
