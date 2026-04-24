import { ipcMain } from 'electron';
import { parseJsonObject } from '@costgoblin/core';
import type { SavingsPreferences } from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';

export function registerSavingsHandlers(app: AppContext): void {
  const { ctx } = app;

  const savingsPrefsPath = () => prefsPath(ctx.dataDir, 'savings-preferences');

  ipcMain.handle('savings:get-preferences', async (): Promise<SavingsPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await savingsPrefsPath(), 'utf-8');
      const obj = parseJsonObject(raw);
      const hiddenActionTypes = obj?.['hiddenActionTypes'];
      if (Array.isArray(hiddenActionTypes) && hiddenActionTypes.every((v): v is string => typeof v === 'string')) {
        return { hiddenActionTypes };
      }
    } catch {
      // file doesn't exist yet
    }
    return { hiddenActionTypes: [] };
  });

  ipcMain.handle('savings:save-preferences', async (_event, prefs: SavingsPreferences): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.writeFile(await savingsPrefsPath(), JSON.stringify(prefs, null, 2));
  });
}
