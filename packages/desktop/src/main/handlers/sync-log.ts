import { BrowserWindow, ipcMain } from 'electron';
import { snapshotSyncLog, clearSyncLog, onSyncLogAppend } from '../sync-log.js';

/** Surface the live sync/S3 activity log to the renderer. Mirrors the
 *  rollup-status channel (handlers/rollup.ts): a pull getter for the backlog on
 *  mount, plus a main→renderer broadcast on every appended line so the Data &
 *  Sync panel tails it without polling. */
export function registerSyncLogHandlers(): void {
  ipcMain.handle('sync-log:get', () => snapshotSyncLog());
  ipcMain.handle('sync-log:clear', () => { clearSyncLog(); });

  onSyncLogAppend((line) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sync-log:append', line);
    }
  });
}
