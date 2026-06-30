import { BrowserWindow, ipcMain } from 'electron';
import type { SyncLogLevel } from '@costgoblin/core';
import { snapshotSyncLog, clearSyncLog, onSyncLogAppend, recordSyncLog } from '../sync-log.js';

/** Surface the live sync/S3 activity log to the renderer. Mirrors the
 *  rollup-status channel (handlers/rollup.ts): a pull getter for the backlog on
 *  mount, plus a main→renderer broadcast on every appended line so the Data &
 *  Sync panel tails it without polling. */
export function registerSyncLogHandlers(): void {
  ipcMain.handle('sync-log:get', () => snapshotSyncLog());
  ipcMain.handle('sync-log:clear', () => { clearSyncLog(); });

  // Renderer-originated lines (on-demand Sync/Prune narrating the S3 check).
  ipcMain.handle('sync-log:record', (_event, level: unknown, message: unknown) => {
    if (typeof message !== 'string') return;
    const lvl: SyncLogLevel = level === 'debug' || level === 'warn' || level === 'error' ? level : 'info';
    recordSyncLog(lvl, message);
  });

  onSyncLogAppend((line) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('sync-log:append', line);
    }
  });
}
