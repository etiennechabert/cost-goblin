import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { UpdateInfo as ElectronUpdaterUpdateInfo } from 'electron-updater';
import { EventEmitter } from 'events';

// Mock electron-updater before importing UpdateManager
const mockAutoUpdater = new EventEmitter() as EventEmitter & {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates: ReturnType<typeof vi.fn>;
  downloadUpdate: ReturnType<typeof vi.fn>;
  quitAndInstall: ReturnType<typeof vi.fn>;
};
mockAutoUpdater.autoDownload = true;
mockAutoUpdater.autoInstallOnAppQuit = true;
mockAutoUpdater.checkForUpdates = vi.fn().mockResolvedValue(undefined);
mockAutoUpdater.downloadUpdate = vi.fn().mockResolvedValue([]);
mockAutoUpdater.quitAndInstall = vi.fn();

vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
}));

// Mock logger
vi.mock('@costgoblin/core', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// Import after mocks are set up
const {
  getUpdateStatus,
  getUpdateInfo,
  checkForUpdates,
  downloadUpdate,
  quitAndInstall,
  startUpdateChecker,
  stopUpdateChecker,
} = await import('../main/update-manager.js');

describe('UpdateManager', () => {
  beforeEach(() => {
    // Stop any running checker and clear state
    stopUpdateChecker();
    vi.clearAllMocks();
    mockAutoUpdater.removeAllListeners();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopUpdateChecker();
    vi.useRealTimers();
  });

  describe('getUpdateStatus', () => {
    it('returns idle or not-available state after no update found', () => {
      // Note: Due to module-level state, this might be idle or not-available
      // depending on whether other tests have run. Testing the not-available
      // state explicitly is more reliable.
      startUpdateChecker();
      mockAutoUpdater.emit('update-not-available');
      const status = getUpdateStatus();
      expect(status).toEqual({ state: 'not-available' });
    });

    it('returns checking state when checking for updates', () => {
      startUpdateChecker();
      mockAutoUpdater.emit('checking-for-update');
      const status = getUpdateStatus();
      expect(status).toEqual({ state: 'checking' });
    });

    it('returns available state with update info when update is available', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.2.3',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: 'Bug fixes and improvements',
      } as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const status = getUpdateStatus();

      expect(status.state).toBe('available');
      if (status.state === 'available') {
        expect(status.info.version).toBe('1.2.3');
        expect(status.info.releaseDate).toBe('2026-04-30T00:00:00.000Z');
        expect(status.info.releaseNotes).toBe('Bug fixes and improvements');
      }
    });

    it('returns not-available state when no update is found', () => {
      startUpdateChecker();
      mockAutoUpdater.emit('update-not-available');
      const status = getUpdateStatus();
      expect(status).toEqual({ state: 'not-available' });
    });

    it('returns downloading state with percent during download', () => {
      startUpdateChecker();
      mockAutoUpdater.emit('download-progress', { percent: 42.5 });
      const status = getUpdateStatus();
      expect(status).toEqual({ state: 'downloading', percent: 43 });
    });

    it('returns downloaded state when update is fully downloaded', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.2.3',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: 'Bug fixes and improvements',
      } as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-downloaded', mockUpdateInfo);
      const status = getUpdateStatus();

      expect(status.state).toBe('downloaded');
      if (status.state === 'downloaded') {
        expect(status.info.version).toBe('1.2.3');
      }
    });

    it('returns error state when an error occurs', () => {
      startUpdateChecker();
      mockAutoUpdater.emit('error', new Error('Network error'));
      const status = getUpdateStatus();

      expect(status.state).toBe('error');
      if (status.state === 'error') {
        expect(status.message).toBe('Network error');
      }
    });
  });

  describe('getUpdateInfo', () => {
    it('returns null after update-not-available event', () => {
      startUpdateChecker();
      mockAutoUpdater.emit('update-not-available');
      const info = getUpdateInfo();
      expect(info).toBeNull();
    });

    it('returns update info after update-available event', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.2.3',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: 'Bug fixes and improvements',
      } as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const info = getUpdateInfo();

      expect(info).toEqual({
        version: '1.2.3',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: 'Bug fixes and improvements',
      });
    });

    it('returns null after update-not-available event', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.2.3',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: 'Bug fixes and improvements',
      } as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      expect(getUpdateInfo()).not.toBeNull();

      mockAutoUpdater.emit('update-not-available');
      expect(getUpdateInfo()).toBeNull();
    });
  });

  describe('convertUpdateInfo', () => {
    it('handles string release notes', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.0.0',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: 'Simple string notes',
      } as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const info = getUpdateInfo();

      expect(info?.releaseNotes).toBe('Simple string notes');
    });

    it('handles array of release notes', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.0.0',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: ['Note 1', 'Note 2', 'Note 3'],
      } as unknown as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const info = getUpdateInfo();

      expect(info?.releaseNotes).toBe('Note 1\n\nNote 2\n\nNote 3');
    });

    it('handles array of note objects', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.0.0',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: [{ note: 'Object note 1' }, { note: 'Object note 2' }],
      } as unknown as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const info = getUpdateInfo();

      expect(info?.releaseNotes).toBe('Object note 1\n\nObject note 2');
    });

    it('handles null release notes', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.0.0',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: null,
      } as unknown as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const info = getUpdateInfo();

      expect(info?.releaseNotes).toBeNull();
    });

    it('handles empty array of release notes', () => {
      const mockUpdateInfo: ElectronUpdaterUpdateInfo = {
        version: '1.0.0',
        releaseDate: '2026-04-30T00:00:00.000Z',
        releaseNotes: [],
      } as unknown as ElectronUpdaterUpdateInfo;

      startUpdateChecker();
      mockAutoUpdater.emit('update-available', mockUpdateInfo);
      const info = getUpdateInfo();

      expect(info?.releaseNotes).toBeNull();
    });
  });

  describe('checkForUpdates', () => {
    it('calls autoUpdater.checkForUpdates', async () => {
      await checkForUpdates();
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    });

    it('sets error state if check fails', async () => {
      mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Network error'));
      await checkForUpdates();
      const status = getUpdateStatus();
      expect(status.state).toBe('error');
      if (status.state === 'error') {
        expect(status.message).toBe('Network error');
      }
    });

    it('handles non-Error thrown values', async () => {
      mockAutoUpdater.checkForUpdates.mockRejectedValueOnce('string error');
      await checkForUpdates();
      const status = getUpdateStatus();
      expect(status.state).toBe('error');
      if (status.state === 'error') {
        expect(status.message).toBe('string error');
      }
    });
  });

  describe('downloadUpdate', () => {
    it('calls autoUpdater.downloadUpdate', async () => {
      await downloadUpdate();
      expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    });

    it('sets downloading state with 0 percent initially', async () => {
      const downloadPromise = downloadUpdate();
      const status = getUpdateStatus();
      expect(status).toEqual({ state: 'downloading', percent: 0 });
      await downloadPromise;
    });

    it('sets error state and throws if download fails', async () => {
      mockAutoUpdater.downloadUpdate.mockRejectedValueOnce(new Error('Download failed'));
      await expect(downloadUpdate()).rejects.toThrow('Download failed');
      const status = getUpdateStatus();
      expect(status.state).toBe('error');
      if (status.state === 'error') {
        expect(status.message).toBe('Download failed');
      }
    });
  });

  describe('quitAndInstall', () => {
    it('calls autoUpdater.quitAndInstall with correct flags', () => {
      quitAndInstall();
      // Use vi.runAllTimers to execute setImmediate callbacks
      vi.runAllTimers();
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    });
  });

  describe('startUpdateChecker and stopUpdateChecker', () => {
    it('configures autoUpdater with manual download and install', () => {
      startUpdateChecker();
      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    });

    it('checks for updates after initial delay', async () => {
      startUpdateChecker();
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();

      // Advance 10 seconds (INITIAL_CHECK_DELAY_MS)
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    });

    it('checks for updates every 6 hours after initial check', async () => {
      startUpdateChecker();

      // Initial check at 10 seconds
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();

      // First recurring check at 6 hours
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);

      // Second recurring check at 12 hours
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(3);
    });

    it('stops update checker and clears timers', async () => {
      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();

      stopUpdateChecker();

      // Advance 6 more hours — should not trigger another check
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    });

    it('removes all autoUpdater listeners on stop', () => {
      startUpdateChecker();
      const listenersBefore = mockAutoUpdater.listenerCount('checking-for-update');
      expect(listenersBefore).toBeGreaterThan(0);

      stopUpdateChecker();
      const listenersAfter = mockAutoUpdater.listenerCount('checking-for-update');
      expect(listenersAfter).toBe(0);
    });

    it('can be safely called multiple times (stop before start)', async () => {
      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();

      // Stop and restart
      stopUpdateChecker();
      startUpdateChecker();
      await vi.advanceTimersByTimeAsync(10000);
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    });
  });

  describe('error handling', () => {
    it('handles error event from autoUpdater', () => {
      startUpdateChecker();
      const error = new Error('Update check failed');
      mockAutoUpdater.emit('error', error);

      const status = getUpdateStatus();
      expect(status.state).toBe('error');
      if (status.state === 'error') {
        expect(status.message).toBe('Update check failed');
      }
    });

    it('handles non-Error values in error event', () => {
      startUpdateChecker();
      mockAutoUpdater.emit('error', 'string error value');

      const status = getUpdateStatus();
      expect(status.state).toBe('error');
      if (status.state === 'error') {
        expect(status.message).toBe('string error value');
      }
    });
  });
});
