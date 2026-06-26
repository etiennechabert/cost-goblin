import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import { logger, isStringRecord } from '@costgoblin/core';
import type { UpdateInfo, UpdateLogEntry, UpdateStage, UpdateStatus } from '@costgoblin/core';

type StatusListener = (status: UpdateStatus) => void;

const LOG_BUFFER_LIMIT = 50;

let currentStatus: UpdateStatus = { state: 'idle' };
const listeners = new Set<StatusListener>();
const logBuffer: UpdateLogEntry[] = [];

function pushLog(level: UpdateLogEntry['level'], message: string): void {
  logBuffer.push({ timestamp: Date.now(), level, message });
  if (logBuffer.length > LOG_BUFFER_LIMIT) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_LIMIT);
  }
}

function snapshotLogs(): readonly UpdateLogEntry[] {
  return logBuffer.slice();
}

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

function stageForCurrentStatus(): UpdateStage {
  switch (currentStatus.state) {
    case 'downloading':
    case 'available':
      return 'download';
    case 'downloaded':
      return 'install';
    default:
      return 'check';
  }
}

function formatError(err: unknown): { message: string; details: string | null } {
  if (err instanceof Error) {
    return { message: err.message, details: err.stack ?? null };
  }
  return { message: String(err), details: null };
}

function isManifestNotReady(err: unknown): boolean {
  // A freshly tagged release is published before its CI build finishes
  // uploading the update manifest (latest-mac.yml / latest.yml). macOS
  // notarization alone adds minutes, during which the manifest 404s. That's
  // transient — the release is still building — not a real failure.
  //
  // electron-updater's GitHubProvider catches the underlying HttpError(404)
  // and rethrows a fresh Error tagged with this code, so the original
  // statusCode is gone by the time it reaches us — match the code (and fall
  // back to the message for older/other electron-updater builds).
  if (isStringRecord(err) && err['code'] === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') return true;
  const message = err instanceof Error ? err.message : String(err);
  return /Cannot find .+\.yml in the latest release/i.test(message);
}

let currentInfo: UpdateInfo | null = null;
let hasTriedFullDownload = false;

export function initAutoUpdater(): void {
  const updater = autoUpdater;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;

  updater.on('checking-for-update', () => {
    pushLog('info', 'Checking for updates');
    setStatus({ state: 'checking' });
  });

  updater.on('update-available', (info) => {
    currentInfo = toUpdateInfo(info);
    hasTriedFullDownload = false;
    updater.disableDifferentialDownload = false;
    pushLog('info', `Update available: v${currentInfo.version} (${currentInfo.releaseDate})`);
    setStatus({ state: 'available', info: currentInfo });
  });

  updater.on('update-not-available', () => {
    pushLog('info', 'No update available');
    setStatus({ state: 'idle' });
  });

  updater.on('download-progress', (progress) => {
    if (currentInfo === null) return;
    const percent = Math.round(progress.percent);
    // Log at 25% increments to avoid flooding the buffer.
    if (percent % 25 === 0) {
      pushLog('info', `Download progress: ${String(percent)}%`);
    }
    setStatus({ state: 'downloading', percent, info: currentInfo });
  });

  updater.on('update-downloaded', (info) => {
    const downloadedInfo = toUpdateInfo(info);
    currentInfo = downloadedInfo;
    pushLog('info', `Download complete: v${downloadedInfo.version}`);
    setStatus({ state: 'downloaded', info: downloadedInfo });
  });

  updater.on('error', (err) => {
    const { message, details } = formatError(err);
    // Differential download can hang or fail mid-stream when the cached
    // blockmap from the previously installed version doesn't reconstruct
    // cleanly against the new zip. Fall back to a full download once
    // before surfacing the error.
    //
    // electron-updater emits 'error' synchronously from inside the
    // download promise's .catch, BEFORE the chained .finally clears its
    // internal downloadPromise. A synchronous retry here would hit the
    // "already in progress" guard and return the same rejected promise.
    // Defer with setImmediate so the .finally runs first.
    if (currentStatus.state === 'downloading' && !hasTriedFullDownload && currentInfo !== null) {
      logger.warn('Differential download failed, retrying with full download', { error: message });
      pushLog('warn', `Differential download failed, retrying with full download: ${message}`);
      hasTriedFullDownload = true;
      updater.disableDifferentialDownload = true;
      setStatus({ state: 'downloading', percent: 0, info: currentInfo });
      setImmediate(() => {
        autoUpdater.downloadUpdate().catch((retryErr: unknown) => {
          const retryFormatted = formatError(retryErr);
          pushLog('error', `Full-download retry failed: ${retryFormatted.message}`);
          if (retryFormatted.details !== null) pushLog('error', retryFormatted.details);
          setStatus({
            state: 'error',
            error: retryFormatted.message,
            stage: 'download',
            logs: snapshotLogs(),
          });
        });
      });
      return;
    }
    const stage = stageForCurrentStatus();
    // While checking, a missing manifest means the latest release hasn't
    // finished publishing its build. Report "no update yet" rather than
    // alarming the user with a stack trace.
    if (stage === 'check' && isManifestNotReady(err)) {
      pushLog('info', 'Latest release is still publishing its build; no update yet');
      setStatus({ state: 'idle' });
      return;
    }
    pushLog('error', `${stage} failed: ${message}`);
    if (details !== null) pushLog('error', details);
    setStatus({ state: 'error', error: message, stage, logs: snapshotLogs() });
  });

  logger.info('Auto-updater initialized');
}

export function checkForUpdates(): Promise<void> {
  return autoUpdater.checkForUpdates().then(() => undefined);
}

export function downloadUpdate(): Promise<void> {
  // Flip to a visible "downloading" state immediately. electron-updater emits
  // no progress events while it fetches the blockmap and computes the
  // differential diff, so without this the modal sits on the static Download
  // button for seconds after the click. percent 0 renders as "Preparing...".
  if (currentInfo !== null) {
    pushLog('info', 'Starting download');
    setStatus({ state: 'downloading', percent: 0, info: currentInfo });
  }
  return autoUpdater.downloadUpdate().then(() => undefined);
}

export function quitAndInstall(): void {
  pushLog('info', 'User requested install + restart');
  autoUpdater.quitAndInstall();
}

export function onStatusChanged(callback: StatusListener): () => void {
  listeners.add(callback);
  callback(currentStatus);
  return () => { listeners.delete(callback); };
}
