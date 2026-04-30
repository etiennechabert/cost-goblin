import { ipcMain } from 'electron';
import type { UpdateInfo, UpdateStatus } from '@costgoblin/core';
import {
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  getUpdateStatus,
  getUpdateInfo,
  onStatusChanged,
} from '../update-manager.js';

export function registerUpdateHandlers(): void {
  ipcMain.handle('update:check-for-updates', async (): Promise<void> => {
    await checkForUpdates();
  });

  ipcMain.handle('update:download-update', async (): Promise<void> => {
    await downloadUpdate();
  });

  ipcMain.handle('update:quit-and-install', (): void => {
    quitAndInstall();
  });

  ipcMain.handle('update:get-status', (): UpdateStatus => {
    return getUpdateStatus();
  });

  ipcMain.handle('update:get-info', (): UpdateInfo | null => {
    return getUpdateInfo();
  });
}

export { onStatusChanged };
