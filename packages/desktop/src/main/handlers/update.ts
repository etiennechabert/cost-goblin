import { app, BrowserWindow, ipcMain } from 'electron';
import {
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  onStatusChanged,
} from '../update-manager.js';

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check', () => checkForUpdates());
  ipcMain.handle('update:download', () => downloadUpdate());
  ipcMain.handle('update:quit-and-install', () => { quitAndInstall(); });
  ipcMain.handle('update:get-app-version', () => app.getVersion());
  // Plain relaunch (no update) — telemetry consent changes only take effect at
  // startup, so the Settings toggle restarts the app to apply them.
  ipcMain.handle('app:relaunch', () => { app.relaunch(); app.quit(); });

  onStatusChanged((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update:status-changed', status);
    }
  });
}
