import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';
import type { UpdateStatus } from '@costgoblin/core/browser';

interface MockAutoUpdater extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  disableDifferentialDownload: boolean;
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
  statuses: UpdateStatus[];
}> {
  vi.resetModules();
  mockUpdater.removeAllListeners();
  mockUpdater.disableDifferentialDownload = false;
  mockUpdater.downloadUpdate.mockClear();
  mockUpdater.downloadUpdate.mockResolvedValue([]);

  const mod = await import('../main/update-manager.js');
  const statuses: UpdateStatus[] = [];
  mod.onStatusChanged(s => statuses.push(s));
  return { init: mod.initAutoUpdater, statuses };
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
