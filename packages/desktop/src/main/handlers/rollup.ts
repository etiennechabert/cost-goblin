import { BrowserWindow, ipcMain } from 'electron';
import { getLocalDataInventory, type RollupStats } from '@costgoblin/core';
import type { AppContext } from './context.js';

/** Push rollup compute-state to the renderer. Mirrors the update-status channel
 *  (handlers/update.ts): a pull getter for the initial state on mount, plus a
 *  main→renderer broadcast on every transition so the header indicator tracks
 *  long-running re-rolls without polling. `rollup:get-stats` adds the size KPIs
 *  shown in the popover — rollup rows/bytes from the manifest plus the raw daily
 *  on-disk size (local filesystem, so it works without AWS credentials). */
export function registerRollupHandlers(app: AppContext): void {
  ipcMain.handle('rollup:get-status', () => app.rollupStore.getStatus());

  ipcMain.handle('rollup:get-stats', async (): Promise<RollupStats | null> => {
    const stats = app.rollupStore.getStats();
    if (stats === null) return null;
    let rawBytes = 0;
    try {
      rawBytes = (await getLocalDataInventory(app.ctx.dataDir, 'daily')).local.diskBytes;
    } catch { /* raw size is best-effort — fall back to 0 (compression hidden) */ }
    return { months: stats.months, rollupRows: stats.rows, rollupBytes: stats.bytes, rawBytes };
  });

  app.rollupStore.onStatusChanged((status) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('rollup:status-changed', status);
    }
  });
}
