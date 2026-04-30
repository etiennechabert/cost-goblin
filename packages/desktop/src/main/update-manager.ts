import { autoUpdater } from 'electron-updater';
import type { UpdateInfo as ElectronUpdaterUpdateInfo } from 'electron-updater';
import { logger } from '@costgoblin/core';

export interface UpdateInfo {
  version: string;
  releaseDate: string;
  releaseNotes: string | null;
}

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'available'; info: UpdateInfo }
  | { state: 'downloading'; percent: number }
  | { state: 'downloaded'; info: UpdateInfo }
  | { state: 'not-available' }
  | { state: 'error'; message: string };

let status: UpdateStatus = { state: 'idle' };
let timer: ReturnType<typeof setTimeout> | null = null;
let latestUpdateInfo: UpdateInfo | null = null;

/** Check for updates every 6 hours */
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Initial delay before first check (let the app finish loading) */
const INITIAL_CHECK_DELAY_MS = 10000;

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function getUpdateInfo(): UpdateInfo | null {
  return latestUpdateInfo;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function convertUpdateInfo(info: ElectronUpdaterUpdateInfo): UpdateInfo {
  // Extract release notes from the update info
  // electron-updater provides releaseNotes as string, array, or null
  let notes: string | null = null;
  if (typeof info.releaseNotes === 'string') {
    notes = info.releaseNotes;
  } else if (Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0) {
    // Join array of release notes
    notes = info.releaseNotes
      .map(n => (typeof n === 'object' && n !== null && 'note' in n ? String(n['note']) : String(n)))
      .join('\n\n');
  }

  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: notes,
  };
}

function setupAutoUpdaterEvents(): void {
  autoUpdater.on('checking-for-update', () => {
    logger.info('Update: checking for updates');
    status = { state: 'checking' };
  });

  autoUpdater.on('update-available', (info: ElectronUpdaterUpdateInfo) => {
    const updateInfo = convertUpdateInfo(info);
    latestUpdateInfo = updateInfo;
    logger.info('Update: update available', { version: updateInfo.version });
    status = { state: 'available', info: updateInfo };
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('Update: no update available');
    status = { state: 'not-available' };
    latestUpdateInfo = null;
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const percent = Math.round(progressObj.percent);
    logger.debug('Update: download progress', { percent });
    status = { state: 'downloading', percent };
  });

  autoUpdater.on('update-downloaded', (info: ElectronUpdaterUpdateInfo) => {
    const updateInfo = convertUpdateInfo(info);
    latestUpdateInfo = updateInfo;
    logger.info('Update: update downloaded, ready to install', { version: updateInfo.version });
    status = { state: 'downloaded', info: updateInfo };
  });

  autoUpdater.on('error', (err: Error) => {
    logger.info('Update: error', { error: errorMessage(err) });
    status = { state: 'error', message: errorMessage(err) };
  });
}

async function checkForUpdatesOnce(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err: unknown) {
    logger.info('Update: check failed', { error: errorMessage(err) });
    status = { state: 'error', message: errorMessage(err) };
  }
}

export function startUpdateChecker(): void {
  stopUpdateChecker();
  setupAutoUpdaterEvents();

  // Configure autoUpdater
  autoUpdater.autoDownload = false; // Manual download control
  autoUpdater.autoInstallOnAppQuit = false; // Manual install control

  // Initial check after short delay
  timer = setTimeout(() => {
    void checkForUpdatesOnce().then(() => {
      // Schedule recurring checks
      timer = setInterval(() => {
        void checkForUpdatesOnce();
      }, UPDATE_CHECK_INTERVAL_MS);
    });
  }, INITIAL_CHECK_DELAY_MS);

  logger.info('Update: checker started (checking every 6 hours)');
}

export function stopUpdateChecker(): void {
  if (timer !== null) {
    clearTimeout(timer);
    clearInterval(timer);
    timer = null;
  }
  // Remove all listeners to avoid duplicates if restarted
  autoUpdater.removeAllListeners();
}

export async function checkForUpdates(): Promise<void> {
  await checkForUpdatesOnce();
}

export async function downloadUpdate(): Promise<void> {
  try {
    status = { state: 'downloading', percent: 0 };
    await autoUpdater.downloadUpdate();
  } catch (err: unknown) {
    logger.info('Update: download failed', { error: errorMessage(err) });
    status = { state: 'error', message: errorMessage(err) };
    throw err;
  }
}

export function quitAndInstall(): void {
  // setImmediate ensures all windows can save state before quitting
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
}
