import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type { UpdateSnapshot, UpdateStatus } from '@costgoblin/core/browser';

interface MockAutoUpdater extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
  requestHeaders: Record<string, string> | null;
  downloadUpdate: ReturnType<typeof vi.fn>;
  checkForUpdates: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
}

const { mockUpdater } = await vi.hoisted(async () => {
  const { EventEmitter: NodeEventEmitter } = await import('node:events');
  const e = new NodeEventEmitter() as MockAutoUpdater;
  e.autoDownload = true;
  e.autoInstallOnAppQuit = true;
  e.disableDifferentialDownload = false;
  e.requestHeaders = null;
  e.downloadUpdate = vi.fn(() => Promise.resolve([]));
  e.checkForUpdates = vi.fn(() => Promise.resolve(null));
  e.quitAndInstall = vi.fn();
  return { mockUpdater: e };
});

vi.mock('electron-updater', () => ({
  default: { autoUpdater: mockUpdater },
}));

const AVAILABLE_INFO = { version: '0.2.1', releaseDate: '2026-05-18', releaseNotes: '' };
const NEXT_INFO = { version: '0.2.2', releaseDate: '2026-05-20', releaseNotes: '' };

async function freshManager(): Promise<{
  init: () => void;
  downloadUpdate: () => Promise<void>;
  getStatusSnapshot: () => UpdateSnapshot;
  stagingId: string;
  statuses: UpdateStatus[];
}> {
  vi.resetModules();
  mockUpdater.removeAllListeners();
  // electron-updater's own defaults — reset so the "flags off" assertions
  // below can't pass vacuously on a value a previous test left behind.
  mockUpdater.autoDownload = true;
  mockUpdater.autoInstallOnAppQuit = true;
  mockUpdater.disableDifferentialDownload = false;
  mockUpdater.requestHeaders = null;
  mockUpdater.downloadUpdate.mockClear();
  mockUpdater.downloadUpdate.mockResolvedValue([]);
  mockUpdater.checkForUpdates.mockClear();
  mockUpdater.quitAndInstall.mockClear();

  const mod = await import('../main/update-manager.js');
  const statuses: UpdateStatus[] = [];
  mod.onStatusChanged(s => statuses.push(s));
  return {
    init: mod.initAutoUpdater,
    downloadUpdate: mod.downloadUpdate,
    getStatusSnapshot: mod.getStatusSnapshot,
    stagingId: mod.UPDATER_STAGING_ID,
    statuses,
  };
}

function flushImmediate(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

describe('update-manager differential download fallback', () => {
  beforeEach(() => {
    mockUpdater.removeAllListeners();
    mockUpdater.disableDifferentialDownload = false;
    mockUpdater.downloadUpdate.mockClear();
  });

  it('retries with full download when differential fails mid-stream', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    mockUpdater.emit('download-progress', { percent: 90 });
    mockUpdater.emit('error', new Error('block 42 not found in cache'));

    // Retry is scheduled via setImmediate so electron-updater can clear its
    // internal downloadPromise via the chained .finally. A synchronous retry
    // would hit the "already in progress" guard and return the rejected
    // promise — so this ordering matters.
    expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();

    await flushImmediate();

    expect(mockUpdater.disableDifferentialDownload).toBe(true);
    expect(mockUpdater.downloadUpdate).toHaveBeenCalledTimes(1);

    const last = statuses.at(-1);
    expect(last?.state).toBe('downloading');
    if (last?.state === 'downloading') {
      expect(last.percent).toBe(0);
    }
  });

  it('surfaces the error if the retry also fails', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    mockUpdater.emit('download-progress', { percent: 90 });
    mockUpdater.emit('error', new Error('first failure'));
    await flushImmediate();

    // Second failure during the full-download retry
    mockUpdater.emit('download-progress', { percent: 60 });
    mockUpdater.emit('error', new Error('second failure'));
    await flushImmediate();

    expect(mockUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    const last = statuses.at(-1);
    expect(last?.state).toBe('error');
    if (last?.state === 'error') {
      expect(last.error).toBe('second failure');
    }
  });

  it('does not retry errors fired outside the downloading state', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('error', new Error('check failed'));
    await flushImmediate();

    expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(mockUpdater.disableDifferentialDownload).toBe(false);
    const last = statuses.at(-1);
    expect(last?.state).toBe('error');
  });

  it('resets the retry budget for each new update-available', async () => {
    const { init } = await freshManager();
    init();

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    mockUpdater.emit('download-progress', { percent: 90 });
    mockUpdater.emit('error', new Error('first version failed'));
    await flushImmediate();

    expect(mockUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdater.disableDifferentialDownload).toBe(true);

    // A new version surfaces — we should try differential again first.
    mockUpdater.emit('update-available', NEXT_INFO);
    expect(mockUpdater.disableDifferentialDownload).toBe(false);

    mockUpdater.emit('download-progress', { percent: 90 });
    mockUpdater.emit('error', new Error('next version also failed'));
    await flushImmediate();

    expect(mockUpdater.downloadUpdate).toHaveBeenCalledTimes(2);
    expect(mockUpdater.disableDifferentialDownload).toBe(true);
  });

  it('surfaces a synchronous downloadUpdate rejection from the retry', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.downloadUpdate.mockRejectedValueOnce(new Error('immediate failure'));

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    mockUpdater.emit('download-progress', { percent: 90 });
    mockUpdater.emit('error', new Error('differential failed'));

    await flushImmediate();
    await flushImmediate();

    const last = statuses.at(-1);
    expect(last?.state).toBe('error');
    if (last?.state === 'error') {
      expect(last.error).toBe('immediate failure');
    }
  });
});

describe('update-manager check-stage manifest 404', () => {
  beforeEach(() => {
    mockUpdater.removeAllListeners();
  });

  // electron-updater rethrows the manifest 404 as a fresh Error tagged with
  // this code (the HttpError.statusCode is dropped) — match the real shape.
  it('treats a manifest-not-found code during check as no update available', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('checking-for-update');
    const err = Object.assign(new Error('something unrecognizable'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    mockUpdater.emit('error', err);

    expect(statuses.at(-1)?.state).toBe('idle');
  });

  it('treats a manifest-not-found message during check as no update available', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('checking-for-update');
    mockUpdater.emit('error', new Error('Cannot find latest-mac.yml in the latest release artifacts (https://...)'));

    expect(statuses.at(-1)?.state).toBe('idle');
  });

  it('still surfaces non-404 check errors', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('checking-for-update');
    mockUpdater.emit('error', new Error('network unreachable'));

    const last = statuses.at(-1);
    expect(last?.state).toBe('error');
  });
});

describe('update-manager download feedback', () => {
  beforeEach(() => {
    mockUpdater.removeAllListeners();
  });

  it('flips to downloading at 0% immediately on download, before any progress event', async () => {
    const { init, downloadUpdate, statuses } = await freshManager();
    init();

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    expect(statuses.at(-1)?.state).toBe('available');

    await downloadUpdate();

    expect(mockUpdater.downloadUpdate).toHaveBeenCalledTimes(1);
    const last = statuses.at(-1);
    expect(last?.state).toBe('downloading');
    if (last?.state === 'downloading') {
      expect(last.percent).toBe(0);
    }
  });
});

describe('update-manager leaves download and install to the user', () => {
  beforeEach(() => {
    mockUpdater.removeAllListeners();
  });

  it('turns off electron-updater\'s auto-download and install-on-quit', async () => {
    const { init } = await freshManager();
    expect(mockUpdater.autoDownload).toBe(true);
    expect(mockUpdater.autoInstallOnAppQuit).toBe(true);

    init();

    expect(mockUpdater.autoDownload).toBe(false);
    expect(mockUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it('does not download when an update is found', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('checking-for-update');
    mockUpdater.emit('update-available', AVAILABLE_INFO);
    await flushImmediate();

    expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.state).toBe('available');
  });

  it('does not install when a download completes', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    mockUpdater.emit('update-downloaded', AVAILABLE_INFO);
    await flushImmediate();

    expect(mockUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.state).toBe('downloaded');
  });

  it('does not start a download on an error while an update is only available', async () => {
    const { init, statuses } = await freshManager();
    init();

    mockUpdater.emit('update-available', AVAILABLE_INFO);
    mockUpdater.emit('error', new Error('socket hang up'));
    await flushImmediate();

    // The full-download retry only follows a download the user started.
    expect(mockUpdater.downloadUpdate).not.toHaveBeenCalled();
    const last = statuses.at(-1);
    expect(last?.state).toBe('error');
    if (last?.state === 'error') {
      expect(last.stage).toBe('download');
    }
  });
});

describe('update-manager status snapshot', () => {
  beforeEach(() => {
    mockUpdater.removeAllListeners();
  });

  it('reports idle and unchecked before any check', async () => {
    const { init, getStatusSnapshot } = await freshManager();
    init();

    expect(getStatusSnapshot()).toStrictEqual({ status: { state: 'idle' }, checkedThisSession: false });
  });

  it('reports idle and checked after a check finds nothing', async () => {
    const { init, getStatusSnapshot } = await freshManager();
    init();

    mockUpdater.emit('checking-for-update');
    mockUpdater.emit('update-not-available', AVAILABLE_INFO);

    expect(getStatusSnapshot()).toStrictEqual({ status: { state: 'idle' }, checkedThisSession: true });
  });

  it('carries the latest status for a renderer that subscribed late', async () => {
    const { init, getStatusSnapshot } = await freshManager();
    init();

    mockUpdater.emit('checking-for-update');
    mockUpdater.emit('update-available', AVAILABLE_INFO);

    const snapshot = getStatusSnapshot();
    expect(snapshot.checkedThisSession).toBe(true);
    expect(snapshot.status.state).toBe('available');
  });
});

describe('update-manager staging id', () => {
  beforeEach(() => {
    mockUpdater.removeAllListeners();
  });

  it('is the nil UUID, not a per-install identifier', async () => {
    const { stagingId } = await freshManager();
    expect(stagingId).toBe('00000000-0000-0000-0000-000000000000');
  });

  it('overrides x-user-staging-id on every updater request', async () => {
    const { init, stagingId } = await freshManager();
    init();

    expect(mockUpdater.requestHeaders).toStrictEqual({ 'x-user-staging-id': stagingId });
  });

  it('keeps request headers that were already set', async () => {
    const { init, stagingId } = await freshManager();
    mockUpdater.requestHeaders = { 'x-test': '1' };
    init();

    expect(mockUpdater.requestHeaders).toStrictEqual({ 'x-test': '1', 'x-user-staging-id': stagingId });
  });
});
