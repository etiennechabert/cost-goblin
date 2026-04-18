import { ipcMain } from 'electron';
import type { UIPreferences } from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerUIHandlers(app: AppContext): void {
  const { ctx } = app;

  async function uiPrefsPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(path.dirname(ctx.dataDir), 'ui-preferences.json');
  }

  ipcMain.handle('ui:get-preferences', async (): Promise<UIPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await uiPrefsPath(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record: Record<string, unknown> = { ...parsed };
        const theme = record['theme'];
        if (theme === 'light' || theme === 'dark') {
          return { theme };
        }
      }
    } catch {
      // file doesn't exist yet
    }
    return { theme: 'dark' };
  });

  ipcMain.handle('ui:save-preferences', async (_event, prefs: UIPreferences): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(await uiPrefsPath(), JSON.stringify(prefs, null, 2));
  });
}
