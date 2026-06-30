import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { ManifestFileEntry } from '../sync/manifest.js';
import { syncSelectedFiles } from '../sync/selective-sync.js';
import type { SyncProgress } from '../sync/s3-client.js';

vi.mock('node:child_process');
vi.mock('node:fs/promises');
vi.mock('../logger/logger.js');

const file = (key: string, hash = 'h', size = 1): ManifestFileEntry => ({ key, contentHash: hash, size });

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): boolean {
    this.killed = true;
    this.emit('close', null, 'SIGTERM');
    return true;
  }
}

describe('syncSelectedFiles', () => {
  let mockSpawn: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
  let mockMkdir: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  let mockReadFile: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  let mockWriteFile: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  let mockReaddir: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;
  let mockRm: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<unknown>>>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const childProcess = await import('node:child_process');
    const fsPromises = await import('node:fs/promises');

    mockSpawn = vi.fn<(...args: unknown[]) => unknown>();
    childProcess.spawn = mockSpawn as typeof childProcess.spawn;

    mockMkdir = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
    mockReadFile = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockRejectedValue(new Error('ENOENT'));
    mockWriteFile = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
    mockReaddir = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
    mockRm = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);

    fsPromises.mkdir = mockMkdir as typeof fsPromises.mkdir;
    fsPromises.readFile = mockReadFile as typeof fsPromises.readFile;
    fsPromises.writeFile = mockWriteFile as typeof fsPromises.writeFile;
    fsPromises.readdir = mockReaddir as typeof fsPromises.readdir;
    fsPromises.rm = mockRm as typeof fsPromises.rm;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function createSuccessfulSpawn(): MockChildProcess {
    const proc = new MockChildProcess();
    setTimeout(() => { proc.emit('close', 0, null); }, 10);
    return proc;
  }

  function createFailedSpawn(exitCode: number, stderrMessage: string): MockChildProcess {
    const proc = new MockChildProcess();
    setTimeout(() => {
      proc.stderr.emit('data', Buffer.from(stderrMessage));
      proc.emit('close', exitCode, null);
    }, 10);
    return proc;
  }

  it('successfully syncs daily CUR files', async () => {
    const proc = createSuccessfulSpawn();
    mockSpawn.mockReturnValue(proc);

    const files = [
      file('cur/data/BILLING_PERIOD=2026-03/file1.parquet', 'hash1'),
      file('cur/data/BILLING_PERIOD=2026-03/file2.parquet', 'hash2'),
    ];

    const dataDir = join('/tmp', 'test');
    const expectedDest = join(dataDir, 'aws', 'raw', 'daily-2026-03');

    const result = await syncSelectedFiles({
      bucketPath: 's3://test-bucket/cur/data/',
      profile: 'test-profile',
      dataDir,
      expectedDataType: 'daily',
      files,
    });

    expect(result.filesDownloaded).toBe(2);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringContaining('aws'),
      ['s3', 'sync', 's3://test-bucket/cur/data/BILLING_PERIOD=2026-03/', expectedDest, '--profile', 'test-profile'],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
  });

  it('successfully syncs cost-optimization files', async () => {
    mockSpawn.mockImplementation(() => createSuccessfulSpawn());
    mockReaddir.mockResolvedValue(['data.parquet']);

    const files = [
      file('cost-opt/date=2026-03-15/file.parquet', 'hash1'),
      file('cost-opt/date=2026-03-16/file.parquet', 'hash2'),
    ];

    const result = await syncSelectedFiles({
      bucketPath: 's3://test-bucket/cost-opt/',
      profile: 'test-profile',
      dataDir: '/tmp/test',
      expectedDataType: 'cost-optimization',
      files,
    });

    expect(result.filesDownloaded).toBe(2);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('handles multiple periods in sorted order', async () => {
    mockSpawn.mockImplementation(() => createSuccessfulSpawn());

    const files = [
      file('cur/BILLING_PERIOD=2026-01/a.parquet', 'h1'),
      file('cur/BILLING_PERIOD=2026-03/b.parquet', 'h2'),
      file('cur/BILLING_PERIOD=2026-02/c.parquet', 'h3'),
    ];

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir: '/data',
      files,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    const calls = mockSpawn.mock.calls;
    expect(calls[0]?.[1]).toEqual(expect.arrayContaining([expect.stringContaining('2026-01')]));
    expect(calls[1]?.[1]).toEqual(expect.arrayContaining([expect.stringContaining('2026-02')]));
    expect(calls[2]?.[1]).toEqual(expect.arrayContaining([expect.stringContaining('2026-03')]));
  });

  it('calls progress callback during download', async () => {
    const proc = createSuccessfulSpawn();
    mockSpawn.mockReturnValue(proc);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('download: s3://bucket/file1.parquet to /tmp/file1.parquet\n'));
      proc.stdout.emit('data', Buffer.from('Completed 1.5 MB/2.0 MB\n'));
    }, 5);

    const files = [file('cur/BILLING_PERIOD=2026-03/file1.parquet')];
    const progressEvents: SyncProgress[] = [];

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir: '/tmp',
      files,
      onProgress: (progress) => { progressEvents.push(progress); },
    });

    expect(progressEvents.some((p) => p.phase === 'downloading')).toBe(true);
    expect(progressEvents.some((p) => p.phase === 'done')).toBe(true);
    expect(progressEvents.some((p) => p.message?.includes('Completed'))).toBe(true);
  });

  it('calls onFileDownloaded callback when file downloads', async () => {
    const proc = createSuccessfulSpawn();
    mockSpawn.mockReturnValue(proc);

    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from('download: s3://bucket/file.parquet to /tmp/local/file.parquet\n'));
    }, 5);

    const files = [file('cur/BILLING_PERIOD=2026-03/file.parquet')];
    const downloadedPaths: string[] = [];

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir: '/tmp',
      files,
      onFileDownloaded: (localPath) => { downloadedPaths.push(localPath); },
    });

    expect(downloadedPaths).toContain('/tmp/local/file.parquet');
  });

  it('rejects when AWS CLI is not found', async () => {
    const proc = new MockChildProcess();
    setTimeout(() => { proc.emit('error', new Error('spawn aws ENOENT')); }, 10);
    mockSpawn.mockReturnValue(proc);

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
      })
    ).rejects.toThrow('AWS CLI not found');
  });

  it.each([
    [1, 'Access Denied', 'Access Denied'],
    [1, 'Could not connect to the endpoint URL', 'Could not connect to the endpoint URL'],
    [1, 'Read timeout on endpoint URL', 'Read timeout on endpoint URL'],
    [1, 'SSL validation failed', 'SSL validation failed'],
    [255, 'Name or service not known', 'Name or service not known'],
    [1, 'SlowDown: Please reduce your request rate', 'SlowDown: Please reduce your request rate'],
    [1, 'An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied', 'AccessDenied'],
    [1, 'fatal error: An error occurred (403) when calling the HeadObject operation: Forbidden', 'Forbidden'],
  ])('rejects on CLI exit %i with "%s"', async (exitCode, stderr, expectedMessage) => {
    const proc = createFailedSpawn(exitCode, stderr);
    mockSpawn.mockReturnValue(proc);

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
      })
    ).rejects.toThrow(expectedMessage);
  });

  it('cancels sync when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir: '/tmp',
      files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
      signal: controller.signal,
    });

    expect(result.filesDownloaded).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('kills process when aborted during download', async () => {
    const controller = new AbortController();
    const proc = new MockChildProcess();
    mockSpawn.mockReturnValue(proc);

    setTimeout(() => { controller.abort(); }, 5);

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
        signal: controller.signal,
      })
    ).rejects.toThrow('Download cancelled');

    expect(proc.killed).toBe(true);
  });

  it('stops processing additional periods when cancelled', async () => {
    const controller = new AbortController();
    let spawnCount = 0;

    mockSpawn.mockImplementation(() => {
      spawnCount++;
      const proc = new MockChildProcess();
      setTimeout(() => {
        if (spawnCount === 1) {
          proc.stdout.emit('data', Buffer.from('download: file.parquet\n'));
        }
        proc.emit('close', 0, null);
      }, 10);
      return proc;
    });

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [
          file('cur/BILLING_PERIOD=2026-01/a.parquet'),
          file('cur/BILLING_PERIOD=2026-02/b.parquet'),
          file('cur/BILLING_PERIOD=2026-03/c.parquet'),
        ],
        signal: controller.signal,
        onProgress: (progress) => {
          if (progress.phase === 'downloading') controller.abort();
        },
      })
    ).rejects.toThrow('Download cancelled');

    expect(spawnCount).toBe(1);
  });

  it('saves and merges ETags correctly', async () => {
    const proc = createSuccessfulSpawn();
    mockSpawn.mockReturnValue(proc);

    mockReadFile.mockResolvedValueOnce(
      JSON.stringify({ '2026-01': { 'old-file.parquet': 'old-hash' } })
    );

    const files = [file('cur/BILLING_PERIOD=2026-02/new-file.parquet', 'new-hash')];
    const dataDir = '/tmp';
    const expectedEtagFile = join(dataDir, 'sync-etags.json');

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir,
      files,
    });

    expect(mockWriteFile).toHaveBeenCalledWith(expectedEtagFile, expect.stringContaining('2026-01'));
    expect(mockWriteFile).toHaveBeenCalledWith(expectedEtagFile, expect.stringContaining('2026-02'));
    expect(mockWriteFile).toHaveBeenCalledWith(expectedEtagFile, expect.stringContaining('new-hash'));
  });

  describe('stale-file pruning', () => {
    it('deletes local parquet no longer in the current manifest', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      // Staging dir holds the two current parts plus a leftover from a prior export.
      mockReaddir.mockResolvedValue(['file1.parquet', 'file2.parquet', 'stale-old-part.parquet']);

      const files = [
        file('cur/data/BILLING_PERIOD=2026-03/file1.parquet', 'h1'),
        file('cur/data/BILLING_PERIOD=2026-03/file2.parquet', 'h2'),
      ];
      const dataDir = join('/tmp', 'prune-test');
      const dest = join(dataDir, 'aws', 'raw', 'daily-2026-03');

      await syncSelectedFiles({
        bucketPath: 's3://test-bucket/cur/data/',
        profile: 'test-profile',
        dataDir,
        expectedDataType: 'daily',
        files,
      });

      expect(mockRm).toHaveBeenCalledWith(join(dest, 'stale-old-part.parquet'), { force: true });
      expect(mockRm).not.toHaveBeenCalledWith(join(dest, 'file1.parquet'), expect.anything());
      expect(mockRm).not.toHaveBeenCalledWith(join(dest, 'file2.parquet'), expect.anything());
    });

    it('keeps every file when the directory matches the manifest', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['file1.parquet', 'file2.parquet']);

      await syncSelectedFiles({
        bucketPath: 's3://test-bucket/cur/data/',
        profile: 'test-profile',
        dataDir: '/tmp/prune-clean',
        expectedDataType: 'daily',
        files: [
          file('cur/data/BILLING_PERIOD=2026-03/file1.parquet'),
          file('cur/data/BILLING_PERIOD=2026-03/file2.parquet'),
        ],
      });

      expect(mockRm).not.toHaveBeenCalled();
    });

    it('leaves non-parquet files (e.g. in-flight download temp files) untouched', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['file1.parquet', 'file1.parquet.aB3x9', 'notes.txt', 'stale.parquet']);

      const dest = join('/tmp/prune-temp', 'aws', 'raw', 'daily-2026-03');
      await syncSelectedFiles({
        bucketPath: 's3://test-bucket/cur/data/',
        profile: 'test-profile',
        dataDir: '/tmp/prune-temp',
        expectedDataType: 'daily',
        files: [file('cur/data/BILLING_PERIOD=2026-03/file1.parquet')],
      });

      expect(mockRm).toHaveBeenCalledWith(join(dest, 'stale.parquet'), { force: true });
      expect(mockRm).not.toHaveBeenCalledWith(join(dest, 'file1.parquet.aB3x9'), expect.anything());
      expect(mockRm).not.toHaveBeenCalledWith(join(dest, 'notes.txt'), expect.anything());
    });

    it('treats a deletion failure as best-effort and still completes the sync', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['file1.parquet', 'stale.parquet']);
      // The stale file is locked / permission-denied — rm rejects.
      mockRm.mockRejectedValue(new Error('EPERM: operation not permitted'));

      const dataDir = '/tmp/prune-besteffort';
      const result = await syncSelectedFiles({
        bucketPath: 's3://test-bucket/cur/data/',
        profile: 'test-profile',
        dataDir,
        expectedDataType: 'daily',
        files: [file('cur/data/BILLING_PERIOD=2026-03/file1.parquet')],
      });

      // Download succeeded and etags were still persisted despite the prune error.
      expect(result.filesDownloaded).toBe(1);
      expect(mockWriteFile).toHaveBeenCalledWith(join(dataDir, 'sync-etags.json'), expect.any(String));
    });

    it('does not prune when the period sync fails', async () => {
      mockSpawn.mockReturnValue(createFailedSpawn(1, 'Access Denied'));
      mockReaddir.mockResolvedValue(['stale.parquet']);

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://test-bucket/cur/data/',
          profile: 'test-profile',
          dataDir: '/tmp/prune-fail',
          expectedDataType: 'daily',
          files: [file('cur/data/BILLING_PERIOD=2026-03/file1.parquet')],
        })
      ).rejects.toThrow('Access Denied');

      expect(mockRm).not.toHaveBeenCalled();
    });
  });

  it('handles empty file list', async () => {
    const result = await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir: '/tmp',
      files: [],
    });

    expect(result.filesDownloaded).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('creates necessary directories', async () => {
    const proc = createSuccessfulSpawn();
    mockSpawn.mockReturnValue(proc);

    const dataDir = join('/tmp', 'data');

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      dataDir,
      files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      join(dataDir, 'aws', 'raw', 'daily-2026-03'),
      { recursive: true }
    );
  });

  it('fails when network error occurs during multi-period sync', async () => {
    let spawnCount = 0;
    mockSpawn.mockImplementation(() => {
      spawnCount++;
      if (spawnCount === 2) return createFailedSpawn(1, 'Connection timed out');
      return createSuccessfulSpawn();
    });

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [
          file('cur/BILLING_PERIOD=2026-01/a.parquet'),
          file('cur/BILLING_PERIOD=2026-02/b.parquet'),
          file('cur/BILLING_PERIOD=2026-03/c.parquet'),
        ],
      })
    ).rejects.toThrow('Connection timed out');

    expect(spawnCount).toBe(2);
  });

  describe('per-period orchestration', () => {
    /** Helper: sets up mock fs to track etag writes as raw strings */
    function setupEtagTracking(etagFileName = 'sync-etags.json'): { getLastWritten: () => string } {
      let lastWritten = '{}';

      mockReadFile.mockImplementation((path: unknown) => {
        if (String(path).includes(etagFileName)) return Promise.resolve(lastWritten);
        return Promise.reject(new Error('ENOENT'));
      });

      mockWriteFile.mockImplementation((path: unknown, content: unknown) => {
        if (String(path).includes(etagFileName)) {
          lastWritten = String(content);
        }
        return Promise.resolve();
      });

      return { getLastWritten: () => lastWritten };
    }

    it('saves ETags after each period completes', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      const { getLastWritten } = setupEtagTracking();

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [
          file('cur/BILLING_PERIOD=2026-01/a.parquet', 'hash-jan'),
          file('cur/BILLING_PERIOD=2026-02/b.parquet', 'hash-feb'),
          file('cur/BILLING_PERIOD=2026-03/c.parquet', 'hash-mar'),
        ],
      });

      expect(mockWriteFile).toHaveBeenCalledTimes(3);

      const saved = JSON.parse(getLastWritten());
      expect(saved['2026-01']?.['cur/BILLING_PERIOD=2026-01/a.parquet']).toBe('hash-jan');
      expect(saved['2026-02']?.['cur/BILLING_PERIOD=2026-02/b.parquet']).toBe('hash-feb');
      expect(saved['2026-03']?.['cur/BILLING_PERIOD=2026-03/c.parquet']).toBe('hash-mar');
    });

    it('processes periods sequentially', async () => {
      const spawnOrder: string[] = [];

      mockSpawn.mockImplementation((_cmd: unknown, rawArgs: unknown) => {
        const args = rawArgs as string[];
        const period = args.find((arg) => arg.includes('BILLING_PERIOD='))?.match(/2026-\d{2}/)?.[0];
        if (period !== undefined) spawnOrder.push(period);

        const proc = new MockChildProcess();
        setTimeout(() => { proc.emit('close', 0, null); }, 10);
        return proc;
      });

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [
          file('cur/BILLING_PERIOD=2026-01/a.parquet'),
          file('cur/BILLING_PERIOD=2026-02/b.parquet'),
          file('cur/BILLING_PERIOD=2026-03/c.parquet'),
        ],
      });

      expect(spawnOrder).toEqual(['2026-01', '2026-02', '2026-03']);
    });

    it('stops processing subsequent periods when one fails', async () => {
      let spawnCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCount++;
        if (spawnCount === 2) return createFailedSpawn(1, 'Access Denied for period 2');
        return createSuccessfulSpawn();
      });

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cur/',
          profile: 'test',
          dataDir: '/tmp',
          files: [
            file('cur/BILLING_PERIOD=2026-01/a.parquet'),
            file('cur/BILLING_PERIOD=2026-02/b.parquet'),
            file('cur/BILLING_PERIOD=2026-03/c.parquet'),
          ],
        })
      ).rejects.toThrow('Access Denied for period 2');

      expect(spawnCount).toBe(2);
      expect(mockWriteFile).toHaveBeenCalledTimes(1);
      const written = String(mockWriteFile.mock.calls[0]?.[1]);
      expect(written).toContain('2026-01');
      expect(written).not.toContain('2026-02');
    });

    it('tracks progress correctly across multiple periods', async () => {
      const progressEvents: SyncProgress[] = [];

      mockSpawn.mockImplementation(() => {
        const proc = new MockChildProcess();
        setTimeout(() => {
          proc.stdout.emit('data', Buffer.from('download: file1.parquet\n'));
          proc.stdout.emit('data', Buffer.from('download: file2.parquet\n'));
          proc.emit('close', 0, null);
        }, 5);
        return proc;
      });

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [
          file('cur/BILLING_PERIOD=2026-01/a.parquet'),
          file('cur/BILLING_PERIOD=2026-01/b.parquet'),
          file('cur/BILLING_PERIOD=2026-02/c.parquet'),
          file('cur/BILLING_PERIOD=2026-02/d.parquet'),
        ],
        onProgress: (progress) => { progressEvents.push(progress); },
      });

      const downloadEvents = progressEvents.filter((p) => p.phase === 'downloading');
      expect(downloadEvents.every((p) => p.filesTotal === 4)).toBe(true);
      expect(Math.max(...downloadEvents.map((p) => p.filesDone))).toBe(4);

      const doneEvent = progressEvents.find((p) => p.phase === 'done');
      expect(doneEvent?.filesTotal).toBe(4);
      expect(doneEvent?.filesDone).toBe(4);
    });

    it('preserves ETags from previous sync sessions', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      const { getLastWritten } = setupEtagTracking();
      // Seed with pre-existing etag data
      mockReadFile.mockImplementation((path: unknown) => {
        if (String(path).includes('sync-etags.json')) {
          return Promise.resolve(JSON.stringify({ '2025-12': { 'old-file.parquet': 'old-hash' } }));
        }
        return Promise.reject(new Error('ENOENT'));
      });

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [file('cur/BILLING_PERIOD=2026-01/new-file.parquet', 'new-hash-1')],
      });

      const saved = JSON.parse(getLastWritten());
      expect(saved['2025-12']?.['old-file.parquet']).toBe('old-hash');
      expect(saved['2026-01']?.['cur/BILLING_PERIOD=2026-01/new-file.parquet']).toBe('new-hash-1');
    });

    it('handles abort between periods — saves completed period ETags only', async () => {
      const controller = new AbortController();
      let spawnCount = 0;

      const { getLastWritten } = setupEtagTracking();

      mockWriteFile.mockImplementation((path: unknown, content: unknown) => {
        if (String(path).includes('sync-etags.json')) {
          if (spawnCount === 1) controller.abort();
          mockReadFile.mockImplementation((p: unknown) => {
            if (String(p).includes('sync-etags.json')) return Promise.resolve(String(content));
            return Promise.reject(new Error('ENOENT'));
          });
        }
        return Promise.resolve();
      });

      mockSpawn.mockImplementation(() => {
        spawnCount++;
        const proc = new MockChildProcess();
        setTimeout(() => { proc.emit('close', 0, null); }, 10);
        return proc;
      });

      const result = await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        dataDir: '/tmp',
        files: [
          file('cur/BILLING_PERIOD=2026-01/a.parquet'),
          file('cur/BILLING_PERIOD=2026-02/b.parquet'),
          file('cur/BILLING_PERIOD=2026-03/c.parquet'),
        ],
        signal: controller.signal,
      });

      expect(result.filesDownloaded).toBe(1);
      expect(spawnCount).toBe(1);
      void getLastWritten(); // Suppress unused warning
    });
  });

  describe('cost-optimization sync', () => {
    it('groups files by date and syncs each', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['file1.parquet', 'file2.parquet']);

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        dataDir: '/data',
        expectedDataType: 'cost-optimization',
        files: [
          file('cost-opt/date=2026-03-15/file1.parquet', 'h1'),
          file('cost-opt/date=2026-03-15/file2.parquet', 'h2'),
          file('cost-opt/date=2026-03-16/file3.parquet', 'h3'),
        ],
      });

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('cost-opt-2026-03-15'), { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(expect.stringContaining('cost-opt-2026-03-16'), { recursive: true });
    });

    it('emits repartitioning progress', async () => {
      const proc = createSuccessfulSpawn();
      mockSpawn.mockReturnValue(proc);
      mockReaddir.mockResolvedValue(['data.parquet']);

      const progressEvents: SyncProgress[] = [];

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        dataDir: '/tmp',
        expectedDataType: 'cost-optimization',
        files: [file('cost-opt/date=2026-03-15/file.parquet')],
        onProgress: (progress) => { progressEvents.push(progress); },
      });

      expect(progressEvents.some((p) => p.phase === 'repartitioning')).toBe(true);
    });

    it('invokes AWS CLI with correct S3 paths', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['data.parquet']);

      await syncSelectedFiles({
        bucketPath: 's3://test-bucket/cost-opt/',
        profile: 'prod-profile',
        dataDir: '/tmp/test',
        expectedDataType: 'cost-optimization',
        files: [file('cost-opt/date=2026-03-15/file.parquet', 'h1')],
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('aws'),
        ['s3', 'sync', 's3://test-bucket/cost-opt/date=2026-03-15/', expect.stringContaining('cost-opt-2026-03-15'), '--profile', 'prod-profile'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });

    it('writes raw cost-opt dirs and removes the legacy hive copy', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      const dataDir = '/data/test';

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        dataDir,
        expectedDataType: 'cost-optimization',
        files: [
          file('cost-opt/date=2026-03-15/file1.parquet', 'h1'),
          file('cost-opt/date=2026-04-20/file2.parquet', 'h2'),
        ],
      });

      // Data lands in the raw dir the Savings query actually reads...
      expect(mockMkdir).toHaveBeenCalledWith(join(dataDir, 'aws', 'raw', 'cost-opt-2026-03-15'), { recursive: true });
      expect(mockMkdir).toHaveBeenCalledWith(join(dataDir, 'aws', 'raw', 'cost-opt-2026-04-20'), { recursive: true });
      // ...and the legacy, never-read hive copy is removed rather than rewritten.
      expect(mockRm).toHaveBeenCalledWith(join(dataDir, 'aws', 'cost-optimization'), { recursive: true, force: true });
    });

    it('skips files without valid date', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['data.parquet']);

      const result = await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        dataDir: '/tmp',
        expectedDataType: 'cost-optimization',
        files: [
          file('cost-opt/invalid-path/file.parquet', 'h1'),
          file('cost-opt/date=2026-03-15/valid.parquet', 'h2'),
        ],
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(result.filesDownloaded).toBe(1);
    });

    it('stops when aborted between dates', async () => {
      const controller = new AbortController();
      let syncCount = 0;

      mockSpawn.mockImplementation(() => {
        syncCount++;
        const proc = new MockChildProcess();
        setTimeout(() => {
          proc.emit('close', 0, null);
          if (syncCount === 1) controller.abort();
        }, 10);
        return proc;
      });

      mockReaddir.mockResolvedValue(['data.parquet']);

      const result = await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        dataDir: '/tmp',
        expectedDataType: 'cost-optimization',
        files: [
          file('cost-opt/date=2026-03-15/file1.parquet'),
          file('cost-opt/date=2026-03-16/file2.parquet'),
          file('cost-opt/date=2026-03-17/file3.parquet'),
        ],
        signal: controller.signal,
      });

      expect(result.filesDownloaded).toBe(1);
      expect(syncCount).toBe(1);
    });

    it('rejects on permission denied', async () => {
      const proc = createFailedSpawn(1, 'An error occurred (403) when calling the GetObject operation: Forbidden');
      mockSpawn.mockReturnValue(proc);
      mockReaddir.mockResolvedValue(['data.parquet']);

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cost-opt/',
          profile: 'test',
          dataDir: '/tmp',
          expectedDataType: 'cost-optimization',
          files: [file('cost-opt/date=2026-03-15/file.parquet')],
        })
      ).rejects.toThrow('Forbidden');
    });
  });

  describe('disk full errors', () => {
    it('rejects when disk full during download', async () => {
      const proc = new MockChildProcess();
      mockSpawn.mockReturnValue(proc);

      setTimeout(() => {
        proc.stderr.emit('data', Buffer.from('fatal error: An error occurred (ENOSPC) when calling the GetObject operation: No space left on device\n'));
        proc.emit('close', 1, null);
      }, 10);

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cur/',
          profile: 'test',
          dataDir: '/tmp',
          files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
        })
      ).rejects.toThrow('ENOSPC');
    });

    it('rejects when staging directory creation fails', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cur/',
          profile: 'test',
          dataDir: '/tmp',
          files: [file('cur/BILLING_PERIOD=2026-03/file.parquet')],
        })
      ).rejects.toThrow('ENOSPC: no space left on device');
    });

    it('saves ETags for completed periods before failure', async () => {
      let savedRaw = '{}';

      mockReadFile.mockImplementation((path: unknown) => {
        if (String(path).includes('sync-etags.json')) return Promise.resolve(savedRaw);
        return Promise.reject(new Error('ENOENT'));
      });

      mockWriteFile.mockImplementation((path: unknown, content: unknown) => {
        if (String(path).includes('sync-etags.json')) savedRaw = String(content);
        return Promise.resolve();
      });

      let spawnCount = 0;
      mockSpawn.mockImplementation(() => {
        spawnCount++;
        if (spawnCount === 2) return createFailedSpawn(1, 'ENOSPC: no space left on device');
        return createSuccessfulSpawn();
      });

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cur/',
          profile: 'test',
          dataDir: '/tmp',
          files: [
            file('cur/BILLING_PERIOD=2026-01/a.parquet', 'hash-jan'),
            file('cur/BILLING_PERIOD=2026-02/b.parquet', 'hash-feb'),
          ],
        })
      ).rejects.toThrow('ENOSPC');

      const saved = JSON.parse(savedRaw);
      expect(saved['2026-01']?.['cur/BILLING_PERIOD=2026-01/a.parquet']).toBe('hash-jan');
      expect(saved['2026-02']).toBeUndefined();
    });
  });
});
