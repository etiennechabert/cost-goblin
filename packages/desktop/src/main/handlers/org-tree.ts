import { ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { validateOrgTree, orgTreeToYaml } from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerOrgTreeHandlers(app: AppContext): void {
  const { ctx, invalidateOrgTree } = app;

  ipcMain.handle('org-tree:save', async (_event, raw: unknown): Promise<void> => {
    const validated = validateOrgTree({ tree: raw });
    await writeFile(ctx.orgTreePath, stringify(orgTreeToYaml(validated)));
    invalidateOrgTree();
  });
}
