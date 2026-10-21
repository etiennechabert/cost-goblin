import { ipcMain } from 'electron';
import { parseJsonObject, parseSavingsPreferences, parseSavingsPreferencesUpdate, SAVINGS_PREFERENCES_DEFAULTS } from '@costgoblin/core';
import type { SavingsPreferences } from '@costgoblin/core';
import { isEnoent } from '../fs-errors.js';
import { type AppContext, prefsPath } from './context.js';
import { updatePrefsFile } from './prefs-file.js';

export function registerSavingsHandlers(app: AppContext): void {
  const { ctx } = app;

  const savingsPrefsPath = () => prefsPath(ctx.stateDir, 'savings-preferences');

  // Only a missing file means defaults. A file that is there but unreadable
  // rejects, so the view doesn't save its defaults over the user's settings.
  ipcMain.handle('savings:get-preferences', async (): Promise<SavingsPreferences> => {
    const fs = await import('node:fs/promises');
    let raw: string;
    try {
      raw = await fs.readFile(await savingsPrefsPath(), 'utf-8');
    } catch (err: unknown) {
      if (isEnoent(err)) return SAVINGS_PREFERENCES_DEFAULTS;
      throw err;
    }
    return parseSavingsPreferences(parseJsonObject(raw));
  });

  // The view sends only the fields it changed (hidden types, or the counted
  // commitment term): merge them into the file, so one never resets the other.
  ipcMain.handle('savings:save-preferences', async (_event, update: unknown): Promise<void> => {
    const fields = parseSavingsPreferencesUpdate(update);
    await updatePrefsFile(await savingsPrefsPath(), current => ({ ...current, ...fields }));
  });
}
