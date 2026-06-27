import { BrowserWindow, ipcMain } from 'electron';
import type {
  BaselineCreateInput,
  BaselineUpdatePatch,
  BaselinesDiscoveryConfig,
  BaselinesListParams,
} from '@costgoblin/core';
import type { AppContext } from './context.js';

export function registerBaselinesHandlers(app: AppContext): void {
  const store = app.baselineStore;
  const deps = app.baselineEngineDeps;

  // Broadcast recompute/discovery progress so the list can refresh live —
  // mirrors the rollup:status-changed / update:status-changed channels.
  store.onStatusChanged((status) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('baselines:status-changed', status);
  });

  ipcMain.handle('baselines:list', (_e, params: BaselinesListParams) => store.list(deps, params));
  ipcMain.handle('baselines:get', (_e, id: string) => store.getDetail(deps, id));
  ipcMain.handle('baselines:create', (_e, input: BaselineCreateInput) => store.create(deps, input));
  ipcMain.handle('baselines:update', (_e, id: string, patch: BaselineUpdatePatch) => store.update(deps, id, patch));
  ipcMain.handle('baselines:delete', (_e, id: string) => store.delete(deps, id));
  ipcMain.handle('baselines:recompute', (_e, id?: string) => store.recompute(deps, id));
  ipcMain.handle('baselines:snapshots', (_e, id: string) => store.getSnapshots(deps, id));
  ipcMain.handle('baselines:drift', (_e, id: string, childDimension: string) => store.getDrift(deps, id, childDimension));
  ipcMain.handle('baselines:get-config', async () => { await store.load(deps); return store.getConfigState(); });
  ipcMain.handle('baselines:set-config', (_e, config: BaselinesDiscoveryConfig) => store.setConfig(config));
  ipcMain.handle('baselines:reset-config', () => store.resetConfig());
  ipcMain.handle('baselines:status', () => store.getStatus());
}
