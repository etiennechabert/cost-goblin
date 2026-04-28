import { ipcMain } from 'electron';
import { parseJsonObject } from '@costgoblin/core';
import type { UIPreferences } from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';

export function registerUIHandlers(app: AppContext): void {
  const { ctx } = app;

  const uiPrefsPath = () => prefsPath(ctx.dataDir, 'ui-preferences');

  ipcMain.handle('ui:get-preferences', async (): Promise<UIPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await uiPrefsPath(), 'utf-8');
      const parsed = parseJsonObject(raw);
      const theme = parsed?.['theme'];
      const palette = parsed?.['palette'];
      return {
        theme: theme === 'light' || theme === 'dark' ? theme : 'dark',
        palette: palette === 'standard' || palette === 'colorblind' ? palette : 'standard',
      };
    } catch {
      // file doesn't exist yet
    }
    return { theme: 'dark', palette: 'standard' };
  });

  ipcMain.handle('ui:save-preferences', async (_event, prefs: UIPreferences): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(await uiPrefsPath(), JSON.stringify(prefs, null, 2));
  });
}
