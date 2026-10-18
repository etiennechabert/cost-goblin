import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '@costgoblin/core/browser';

/** electron-updater event handling the fallback/snapshot suite in
 *  update-manager.test.ts leaves out: release-note shapes, progress logging,
 *  the error log the modal shows, and the user-driven actions. */

const { updater } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  class FakeAutoUpdater extends EventEmitter {
    autoDownload = true;
    autoInstallOnAppQuit = true;
    disableDifferentialDownload = false;
    requestHeaders: Record<string, string> | null = null;
    readonly downloadUpdate = vi.fn<() => Promise<unknown>>(() => Promise.resolve([]));
    readonly checkForUpdates = vi.fn<() => Promise<unknown>>(() => Promise.resolve(null));
    readonly quitAndInstall = vi.fn<() => void>();
  }
  return { updater: new FakeAutoUpdater() };
});

vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));

type UpdateManager = typeof import('../main/update-manager.js');

/** A freshly loaded, initialised manager plus every status it has emitted. */
async function freshManager(): Promise<{ mod: UpdateManager; statuses: UpdateStatus[] }> {
  vi.resetModules();
  updater.removeAllListeners();
  updater.downloadUpdate.mockReset();
  updater.downloadUpdate.mockResolvedValue([]);
  updater.checkForUpdates.mockReset();
  updater.checkForUpdates.mockResolvedValue(null);
  updater.quitAndInstall.mockReset();
  const mod = await import('../main/update-manager.js');
  mod.initAutoUpdater();
  const statuses: UpdateStatus[] = [];
  mod.onStatusChanged(s => { statuses.push(s); });
  return { mod, statuses };
}

function lastStatus(statuses: readonly UpdateStatus[]): UpdateStatus {
  const status = statuses.at(-1);
  if (status === undefined) throw new Error('no status emitted');
  return status;
}

function errorLogs(statuses: readonly UpdateStatus[]): string[] {
  const status = lastStatus(statuses);
  if (status.state !== 'error') throw new Error(`expected an error status, got ${status.state}`);
  return status.logs.map(l => l.message);
}

const flushImmediate = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

const info = (releaseNotes: unknown): { version: string; releaseDate: string; releaseNotes: unknown } =>
  ({ version: '0.9.0', releaseDate: '2026-10-01', releaseNotes });

beforeEach(() => {
  updater.removeAllListeners();
});

describe('update-manager release notes', () => {
  it('joins notes given per version, skipping entries that carry no text', async () => {
    const { statuses } = await freshManager();

    updater.emit('update-available', info(['Faster sync', { version: '0.8.9', note: 'Fixed the explorer' }, { note: 42 }, 7]));

    expect(lastStatus(statuses)).toEqual({
      state: 'available',
      info: { version: '0.9.0', releaseDate: '2026-10-01', releaseNotes: 'Faster sync\nFixed the explorer' },
    });
  });

  it('reads notes it cannot render as none', async () => {
    const { statuses } = await freshManager();
    const notesOf = (raw: unknown): string | null => {
      updater.emit('update-available', info(raw));
      const status = lastStatus(statuses);
      if (status.state !== 'available') throw new Error('expected available');
      return status.info.releaseNotes;
    };

    expect(notesOf([])).toBeNull();
    expect(notesOf([{ note: null }])).toBeNull();
    expect(notesOf(undefined)).toBeNull();
    expect(notesOf(42)).toBeNull();
    expect(notesOf('## Plain markdown')).toBe('## Plain markdown');
  });
});

describe('update-manager download log', () => {
  it('ignores progress events before any update is known', async () => {
    const { statuses } = await freshManager();
    const before = statuses.length;

    updater.emit('download-progress', { percent: 40 });

    expect(statuses).toHaveLength(before);
  });

  it('logs progress in 25% steps and shows the log when installing fails', async () => {
    const { mod, statuses } = await freshManager();
    updater.emit('update-available', info(''));
    await mod.downloadUpdate();
    for (const percent of [25.2, 30, 49.6, 99]) updater.emit('download-progress', { percent });
    updater.emit('update-downloaded', info(''));

    updater.emit('error', new Error('code signature invalid'));

    const status = lastStatus(statuses);
    expect(status).toMatchObject({ state: 'error', error: 'code signature invalid', stage: 'install' });
    const logs = errorLogs(statuses);
    expect(logs.filter(l => l.startsWith('Download progress'))).toEqual(['Download progress: 25%', 'Download progress: 50%']);
    expect(logs).toContain('Download complete: v0.9.0');
    expect(logs).toContain('install failed: code signature invalid');
  });

  it('reports a non-Error failure by its text, with no details line', async () => {
    const { statuses } = await freshManager();
    updater.emit('checking-for-update');

    updater.emit('error', 'proxy refused the connection');

    expect(lastStatus(statuses)).toMatchObject({ state: 'error', error: 'proxy refused the connection', stage: 'check' });
    expect(errorLogs(statuses).at(-1)).toBe('check failed: proxy refused the connection');
  });

  it('logs only the message of an error that carries no stack trace', async () => {
    const { statuses } = await freshManager();
    updater.emit('checking-for-update');
    const err = new Error('net::ERR_NAME_NOT_RESOLVED');
    delete err.stack;

    updater.emit('error', err);

    expect(errorLogs(statuses).slice(-2)).toEqual(['Checking for updates', 'check failed: net::ERR_NAME_NOT_RESOLVED']);
  });

  it('surfaces a full-download retry that fails with a non-Error', async () => {
    const { mod, statuses } = await freshManager();
    updater.emit('update-available', info(''));
    await mod.downloadUpdate();
    updater.downloadUpdate.mockRejectedValueOnce('socket closed');

    updater.emit('error', new Error('blockmap mismatch'));
    await flushImmediate();
    await flushImmediate();

    expect(lastStatus(statuses)).toMatchObject({ state: 'error', error: 'socket closed', stage: 'download' });
    expect(errorLogs(statuses).at(-1)).toBe('Full-download retry failed: socket closed');
  });

  it('keeps only the 50 most recent log lines', async () => {
    const { statuses } = await freshManager();
    for (let i = 0; i < 60; i++) updater.emit('checking-for-update');

    updater.emit('error', new Error('rate limited'));

    const logs = errorLogs(statuses);
    expect(logs).toHaveLength(50);
    expect(logs).toContain('check failed: rate limited');
  });
});

describe('update-manager user actions', () => {
  it('checks for updates through electron-updater', async () => {
    const { mod } = await freshManager();

    await expect(mod.checkForUpdates()).resolves.toBeUndefined();

    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('installs on request, logging that the user asked for it', async () => {
    const { mod, statuses } = await freshManager();
    updater.emit('update-available', info(''));
    updater.emit('update-downloaded', info(''));

    mod.quitAndInstall();
    updater.emit('error', new Error('install helper crashed'));

    expect(updater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(errorLogs(statuses)).toContain('User requested install + restart');
  });

  it('starts a download without a status flip when no update is known yet', async () => {
    const { mod, statuses } = await freshManager();
    const before = statuses.length;

    await mod.downloadUpdate();

    expect(updater.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveLength(before);
  });

  it('replays the current status to a new subscriber and stops after it unsubscribes', async () => {
    const { mod } = await freshManager();
    updater.emit('checking-for-update');
    const seen: UpdateStatus[] = [];

    const unsubscribe = mod.onStatusChanged(s => { seen.push(s); });
    updater.emit('update-not-available', info(''));
    unsubscribe();
    updater.emit('checking-for-update');

    expect(seen).toEqual([{ state: 'checking' }, { state: 'idle' }]);
  });
});
