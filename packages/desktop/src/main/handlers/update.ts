import { join } from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { UpdateSnapshot } from '@costgoblin/core';
import {
  checkForUpdates,
  downloadUpdate,
  getStatusSnapshot,
  quitAndInstall,
  onStatusChanged,
} from '../update-manager.js';
import { persistCheckOnStartup, readCheckOnStartup } from '../update-prefs.js';
import { POST_SETUP_FLAG } from './setup.js';

/** `stateDir` is the active workspace's state dir — the startup-check
 *  preference lives in its ui-preferences.json, and a workspace switch
 *  relaunches the app, so it is fixed for the process lifetime. */
export function registerUpdateHandlers(stateDir: string): void {
  const uiPrefsFile = join(stateDir, 'ui-preferences.json');

  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:quit-and-install', () => { quitAndInstall(); });
  ipcMain.handle('update:get-app-version', () => app.getVersion());
  // Pull the current state on mount — mirrors rollup:get-status. The push
  // relay below only reaches windows that already exist, so a status set
  // before the renderer subscribed (the launch-time check) is otherwise lost.
  ipcMain.handle('update:get-status', (): UpdateSnapshot => getStatusSnapshot());
  // Settings → General → "Update check". Read and written directly through
  // update-prefs (never ui:save-preferences, whose payload is spread as-is).
  ipcMain.handle('update:get-check-on-startup', (): Promise<boolean> => readCheckOnStartup(uiPrefsFile));
  ipcMain.handle('update:set-check-on-startup', (_event, value: unknown): Promise<void> => persistCheckOnStartup(uiPrefsFile, value));
  // Plain relaunch (no update) — telemetry consent changes only take effect at
  // startup, so the Settings toggle restarts the app to apply them. When the
  // setup wizard triggers it, carry a one-shot flag so the next launch resumes
  // on the data-sync screen (see setup:status / POST_SETUP_FLAG).
  ipcMain.handle('app:relaunch', (_event, postSetup: unknown) => {
    // Rebuild the args WITHOUT any stale --post-setup, then re-add it only for the
    // wizard's relaunch — otherwise this session's leftover flag would ride along
    // on an unrelated restart and wrongly redirect the next launch to data-sync.
    const args = process.argv.slice(1).filter((a) => a !== POST_SETUP_FLAG);
    if (postSetup === true) args.push(POST_SETUP_FLAG);
    app.relaunch({ args });
    app.quit();
  });

  onStatusChanged((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update:status-changed', status);
    }
  });
}
