import { BrowserWindow, ipcMain } from 'electron';
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

  onStatusChanged((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('update:status-changed', status);
    }
  });
}
