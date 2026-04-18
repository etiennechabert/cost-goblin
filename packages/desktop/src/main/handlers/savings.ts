import { ipcMain } from 'electron';
import type { SavingsPreferences } from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerSavingsHandlers(app: AppContext): void {
  const { ctx } = app;

  async function savingsPrefsPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(path.dirname(ctx.dataDir), 'savings-preferences.json');
  }

  ipcMain.handle('savings:get-preferences', async (): Promise<SavingsPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      const raw = await fs.readFile(await savingsPrefsPath(), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && 'hiddenActionTypes' in parsed && Array.isArray((parsed as Record<string, unknown>)['hiddenActionTypes'])) {
        return parsed as SavingsPreferences;
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
