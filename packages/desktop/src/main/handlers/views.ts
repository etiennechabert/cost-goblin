import { ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { SEED_VIEWS_CONFIG, validateViews, viewsConfigToYaml } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerViewsHandlers(app: AppContext): void {
  const { ctx, getViews, invalidateViews } = app;

  ipcMain.handle('views:get-config', async (): Promise<ViewsConfig> => {
    try {
      return await getViews();
    } catch {
      // Missing / unreadable file → seed it lazily so first-run users get a
      // working dashboard without going through setup again.
      await writeFile(ctx.viewsPath, stringify(viewsConfigToYaml(SEED_VIEWS_CONFIG)));
      invalidateViews();
      return SEED_VIEWS_CONFIG;
    }
  });

  ipcMain.handle('views:save-config', async (_event, raw: unknown): Promise<void> => {
    const validated = validateViews(raw);
    await writeFile(ctx.viewsPath, stringify(viewsConfigToYaml(validated)));
    invalidateViews();
  });

  ipcMain.handle('views:reset-defaults', async (): Promise<ViewsConfig> => {
    await writeFile(ctx.viewsPath, stringify(viewsConfigToYaml(SEED_VIEWS_CONFIG)));
    invalidateViews();
    return SEED_VIEWS_CONFIG;
  });

  ipcMain.handle('views:reveal-folder', (): void => {
    shell.showItemInFolder(ctx.viewsPath);
  });
}
