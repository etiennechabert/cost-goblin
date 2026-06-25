import { BrowserWindow, ipcMain } from 'electron';
import type { AppContext } from './context.js';

/** Push rollup compute-state to the renderer. Mirrors the update-status channel
 *  (handlers/update.ts): a pull getter for the initial state on mount, plus a
 *  main→renderer broadcast on every transition so the header indicator tracks
 *  long-running re-rolls without polling. */
export function registerRollupHandlers(app: AppContext): void {
  ipcMain.handle('rollup:get-status', () => app.rollupStore.getStatus());

  app.rollupStore.onStatusChanged((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('rollup:status-changed', status);
    }
  });
}
