import { ipcMain, shell } from 'electron';
import { dimensionIdSet, SEED_VIEWS_CONFIG, validateViews } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';
import { loadViewsOrSeed, saveViews, type ViewsFile } from '../views-file.js';
import type { AppContext } from './context.js';

export function registerViewsHandlers(app: AppContext): void {
  const { ctx, getViews, getQueryDimensions, invalidateViews } = app;
  const viewsFile = (): ViewsFile => ({ path: ctx.viewsPath, load: getViews, invalidate: invalidateViews });

  ipcMain.handle('views:get-config', (): Promise<ViewsConfig> => loadViewsOrSeed(viewsFile()));

  ipcMain.handle('views:save-config', async (_event, raw: unknown): Promise<void> => {
    // Live dimension ids exempt current `tag_user_*`-shaped dimensions from
    // the CUR-era renames — otherwise saving a view grouped by one would
    // silently persist a corrupted id.
    const validated = validateViews(raw, dimensionIdSet(await getQueryDimensions()));
    await saveViews(viewsFile(), validated);
  });

  ipcMain.handle('views:reset-defaults', async (): Promise<ViewsConfig> => {
    await saveViews(viewsFile(), SEED_VIEWS_CONFIG);
    return SEED_VIEWS_CONFIG;
  });

  ipcMain.handle('views:reveal-folder', (): void => {
    shell.showItemInFolder(ctx.viewsPath);
  });
}
