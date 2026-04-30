import { autoUpdater } from 'electron-updater';
import type { UpdateInfo as ElectronUpdaterUpdateInfo } from 'electron-updater';
import { logger } from '@costgoblin/core';
import type { UpdateInfo, UpdateStatus } from '@costgoblin/core';

let status: UpdateStatus = { state: 'idle' };
let timer: ReturnType<typeof setTimeout> | null = null;
let latestUpdateInfo: UpdateInfo | null = null;

type StatusListener = (status: UpdateStatus) => void;
const statusListeners = new Set<StatusListener>();

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_CHECK_DELAY_MS = 10000;

function setStatus(next: UpdateStatus): void {
  status = next;
  for (const listener of statusListeners) {
    listener(next);
  }
}

export function onStatusChanged(callback: StatusListener): () => void {
  statusListeners.add(callback);
  return () => { statusListeners.delete(callback); };
}

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
  let notes: string | null = null;
  if (typeof info.releaseNotes === 'string') {
    notes = info.releaseNotes;
  } else if (Array.isArray(info.releaseNotes) && info.releaseNotes.length > 0) {
    notes = info.releaseNotes
      .map((n: string | { readonly note: string | null }) =>
        typeof n === 'string' ? n : (n.note ?? ''))
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
    setStatus({ state: 'checking' });
  });

  autoUpdater.on('update-available', (info: ElectronUpdaterUpdateInfo) => {
    const updateInfo = convertUpdateInfo(info);
    latestUpdateInfo = updateInfo;
    logger.info('Update: update available', { version: updateInfo.version });
    setStatus({ state: 'available', info: updateInfo });
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('Update: no update available');
    latestUpdateInfo = null;
    setStatus({ state: 'not-available' });
  });

  autoUpdater.on('download-progress', (progressObj) => {
    const percent = Math.round(progressObj.percent);
    logger.debug('Update: download progress', { percent });
    setStatus({ state: 'downloading', percent });
  });

  autoUpdater.on('update-downloaded', (info: ElectronUpdaterUpdateInfo) => {
    const updateInfo = convertUpdateInfo(info);
    latestUpdateInfo = updateInfo;
    logger.info('Update: downloaded, ready to install', { version: updateInfo.version });
    setStatus({ state: 'downloaded', info: updateInfo });
  });

  autoUpdater.on('error', (err: Error) => {
    logger.info('Update: error', { error: errorMessage(err) });
    setStatus({ state: 'error', message: errorMessage(err) });
  });
}

async function checkForUpdatesOnce(): Promise<void> {
  try {
    await autoUpdater.checkForUpdates();
  } catch (err: unknown) {
    logger.info('Update: check failed', { error: errorMessage(err) });
    setStatus({ state: 'error', message: errorMessage(err) });
  }
}

export function startUpdateChecker(): void {
  stopUpdateChecker();
  setupAutoUpdaterEvents();

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  timer = setTimeout(() => {
    void checkForUpdatesOnce().then(() => {
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
  autoUpdater.removeAllListeners();
}

export async function checkForUpdates(): Promise<void> {
  await checkForUpdatesOnce();
}

export async function downloadUpdate(): Promise<void> {
  try {
    setStatus({ state: 'downloading', percent: 0 });
    await autoUpdater.downloadUpdate();
  } catch (err: unknown) {
    logger.info('Update: download failed', { error: errorMessage(err) });
    setStatus({ state: 'error', message: errorMessage(err) });
    throw err;
  }
}

export function quitAndInstall(): void {
  setImmediate(() => {
    autoUpdater.quitAndInstall(false, true);
  });
}
