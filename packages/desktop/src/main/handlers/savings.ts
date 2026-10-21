import { ipcMain } from 'electron';
import { parseJsonObject, parseSavingsPreferences, parseSavingsPreferencesUpdate, SAVINGS_PREFERENCES_DEFAULTS } from '@costgoblin/core';
import type { SavingsPreferences } from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';
import { updatePrefsFile } from './prefs-file.js';

export function registerSavingsHandlers(app: AppContext): void {
  const { ctx } = app;

  const savingsPrefsPath = () => prefsPath(ctx.stateDir, 'savings-preferences');

  ipcMain.handle('savings:get-preferences', async (): Promise<SavingsPreferences> => {
    const fs = await import('node:fs/promises');
    try {
      return parseSavingsPreferences(parseJsonObject(await fs.readFile(await savingsPrefsPath(), 'utf-8')));
    } catch {
      // file doesn't exist yet
      return SAVINGS_PREFERENCES_DEFAULTS;
    }
  });

  // The view sends only the fields it changed (hidden types, or the counted
  // commitment term): merge them into the file, so one never resets the other.
  ipcMain.handle('savings:save-preferences', async (_event, update: unknown): Promise<void> => {
    const fields = parseSavingsPreferencesUpdate(update);
    await updatePrefsFile(await savingsPrefsPath(), current => ({ ...current, ...fields }));
  });
}
