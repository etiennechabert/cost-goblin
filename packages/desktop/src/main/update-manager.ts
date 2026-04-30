import { logger, isStringRecord } from '@costgoblin/core';
import type { UpdateInfo, UpdateStatus } from '@costgoblin/core';

// Lazy-loaded — electron-updater crashes in dev/CI when app is not packaged
let _updater: import('electron-updater').AppUpdater | null = null;
async function loadUpdater(): Promise<import('electron-updater').AppUpdater> {
  if (_updater === null) {
    const mod = await import('electron-updater');
    _updater = mod.autoUpdater;
  }
  return _updater;
}

type StatusListener = (status: UpdateStatus) => void;

let currentStatus: UpdateStatus = { state: 'idle' };
const listeners = new Set<StatusListener>();

function setStatus(status: UpdateStatus): void {
  currentStatus = status;
  for (const listener of listeners) {
    listener(status);
  }
}

function extractReleaseNotes(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    const items: unknown[] = raw;
    for (const item of items) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (isStringRecord(item)) {
        const note = item['note'];
        if (typeof note === 'string') parts.push(note);
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  }
  return null;
}

function toUpdateInfo(info: { version: string; releaseDate: string; releaseNotes?: unknown }): UpdateInfo {
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseNotes: extractReleaseNotes(info.releaseNotes),
  };
}

let currentInfo: UpdateInfo | null = null;

export async function initAutoUpdater(): Promise<void> {
  const updater = await loadUpdater();
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on('checking-for-update', () => {
    setStatus({ state: 'checking' });
  });

  updater.on('update-available', (info) => {
    currentInfo = toUpdateInfo(info);
    setStatus({ state: 'available', info: currentInfo });
  });

  updater.on('update-not-available', () => {
    setStatus({ state: 'idle' });
  });

  updater.on('download-progress', (progress) => {
    if (currentInfo === null) return;
    setStatus({ state: 'downloading', percent: Math.round(progress.percent), info: currentInfo });
  });

  updater.on('update-downloaded', (info) => {
    const downloadedInfo = toUpdateInfo(info);
    currentInfo = downloadedInfo;
    setStatus({ state: 'downloaded', info: downloadedInfo });
  });

  updater.on('error', (err) => {
    setStatus({ state: 'error', error: err.message });
  });

  logger.info('Auto-updater initialized');
}

export async function checkForUpdates(): Promise<void> {
  const updater = await loadUpdater();
  await updater.checkForUpdates();
}

export async function downloadUpdate(): Promise<void> {
  const updater = await loadUpdater();
  await updater.downloadUpdate();
}

export async function quitAndInstall(): Promise<void> {
  const updater = await loadUpdater();
  updater.quitAndInstall();
}

export function onStatusChanged(callback: StatusListener): () => void {
  listeners.add(callback);
  callback(currentStatus);
  return () => { listeners.delete(callback); };
}
