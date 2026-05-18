import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { logger, isStringRecord } from '@costgoblin/core';
import type { UpdateInfo, UpdateStatus } from '@costgoblin/core';

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
let hasTriedFullDownload = false;

export function initAutoUpdater(): void {
  const updater = autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on('checking-for-update', () => {
    setStatus({ state: 'checking' });
  });

  updater.on('update-available', (info) => {
    currentInfo = toUpdateInfo(info);
    hasTriedFullDownload = false;
    updater.disableDifferentialDownload = false;
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
    // Differential download can hang or fail mid-stream when the cached
    // blockmap from the previously installed version doesn't reconstruct
    // cleanly against the new zip. Fall back to a full download once
    // before surfacing the error.
    if (currentStatus.state === 'downloading' && !hasTriedFullDownload && currentInfo !== null) {
      logger.warn('Differential download failed, retrying with full download', { error: err.message });
      hasTriedFullDownload = true;
      updater.disableDifferentialDownload = true;
      setStatus({ state: 'downloading', percent: 0, info: currentInfo });
      autoUpdater.downloadUpdate().catch((retryErr: unknown) => {
        const message = retryErr instanceof Error ? retryErr.message : String(retryErr);
        setStatus({ state: 'error', error: message });
      });
      return;
    }
    setStatus({ state: 'error', error: err.message });
  });

  logger.info('Auto-updater initialized');
}

export function checkForUpdates(): Promise<void> {
  return autoUpdater.checkForUpdates().then(() => undefined);
}

export function downloadUpdate(): Promise<void> {
  return autoUpdater.downloadUpdate().then(() => undefined);
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

export function onStatusChanged(callback: StatusListener): () => void {
  listeners.add(callback);
  callback(currentStatus);
  return () => { listeners.delete(callback); };
}
