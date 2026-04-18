import { ipcMain } from 'electron';
import type { OrgSyncResult, OrgSyncProgress } from '@costgoblin/core';
import { syncOrgAccounts } from '../aws-org-client.js';
import type { AppContext } from './context.js';

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
      return JSON.parse(raw) as OrgSyncResult;
    } catch {
      return null;
    }
  });

  ipcMain.handle('org:get-progress', (): OrgSyncProgress | null => {
    return orgSyncProgress;
  });
}
