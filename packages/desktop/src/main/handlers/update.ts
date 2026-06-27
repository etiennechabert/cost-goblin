import { app, BrowserWindow, ipcMain } from 'electron';
import {
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  onStatusChanged,
} from '../update-manager.js';
import { POST_SETUP_FLAG } from './setup.js';

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:quit-and-install', () => { quitAndInstall(); });
  ipcMain.handle('update:get-app-version', () => app.getVersion());
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
