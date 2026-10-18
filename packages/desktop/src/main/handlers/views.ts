import { ipcMain, shell } from 'electron';
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { dimensionIdSet, SEED_VIEWS_CONFIG, validateViews, viewsConfigToYaml } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';
import type { AppContext } from './context.js';
import { loadOrSeedViews } from './views-load.js';

export function registerViewsHandlers(app: AppContext): void {
  const { ctx, getViews, getQueryDimensions, invalidateViews } = app;

  ipcMain.handle('views:get-config', (): Promise<ViewsConfig> =>
    loadOrSeedViews({ viewsPath: ctx.viewsPath, getViews, invalidateViews }));

  ipcMain.handle('views:save-config', async (_event, raw: unknown): Promise<void> => {
    // Live dimension ids exempt current `tag_user_*`-shaped dimensions from
    // the CUR-era renames — otherwise saving a view grouped by one would
    // silently persist a corrupted id.
    const validated = validateViews(raw, dimensionIdSet(await getQueryDimensions()));
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
