import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';
import { join } from 'node:path';
import type { ManifestFileEntry } from '../sync/manifest.js';
import { logger } from '../logger/logger.js';
import { syncSelectedFiles } from '../sync/selective-sync.js';
import type { SyncProgress } from '../sync/s3-client.js';
import { asProviderName } from '../types/branded.js';

vi.mock('node:child_process');
vi.mock('node:fs/promises');
vi.mock('../logger/logger.js');

// The suite must not depend on whether the machine running it has the AWS CLI
// installed; individual cases flip this to null to exercise the miss path.
const { mockFindAwsCli } = vi.hoisted(() => ({
  mockFindAwsCli: vi.fn((): string | null => '/mock/trusted/aws'),
}));
vi.mock('../sync/trusted-binaries.js', () => ({ findAwsCli: mockFindAwsCli }));

const file = (key: string, hash = 'h', size = 1): ManifestFileEntry => ({ key, contentHash: hash, size });

const providerName = asProviderName('aws');

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
  /** In-memory stand-in for the files the sync writes (the etag sidecars).
   *  `saveEtags` writes a temp file and renames it over the sidecar, so reads,
   *  writes, renames and removals are all modelled: a test sees the committed
   *  sidecar, never an in-flight temp file. */
  let disk: Map<string, string>;

  const enoent = (path: unknown): NodeJS.ErrnoException =>
    Object.assign(new Error(`ENOENT: no such file or directory, open '${String(path)}'`), { code: 'ENOENT' });

  beforeEach(async () => {
    vi.clearAllMocks();

    const childProcess = await import('node:child_process');
    const fsPromises = await import('node:fs/promises');

    mockSpawn = vi.fn<(...args: unknown[]) => unknown>();
    childProcess.spawn = mockSpawn as typeof childProcess.spawn;

    mockMkdir = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue(undefined);
    disk = new Map();
    mockReadFile = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation((path: unknown) => {
      const content = disk.get(String(path));
      return content === undefined ? Promise.reject(enoent(path)) : Promise.resolve(content);
    });
    mockWriteFile = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation((path: unknown, content: unknown) => {
      disk.set(String(path), String(content));
      return Promise.resolve();
    });
    mockReaddir = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue([]);
    mockRm = vi.fn<(...args: unknown[]) => Promise<unknown>>().mockImplementation((path: unknown) => {
      disk.delete(String(path));
      return Promise.resolve();
    });

    fsPromises.mkdir = mockMkdir as typeof fsPromises.mkdir;
    fsPromises.readFile = mockReadFile as typeof fsPromises.readFile;
    fsPromises.writeFile = mockWriteFile as typeof fsPromises.writeFile;
    fsPromises.readdir = mockReaddir as typeof fsPromises.readdir;
    fsPromises.rm = mockRm as typeof fsPromises.rm;
    vi.mocked(fsPromises.rename).mockImplementation((from, to) => {
      const content = disk.get(String(from));
      if (content === undefined) return Promise.reject(enoent(from));
      disk.delete(String(from));
      disk.set(String(to), content);
      return Promise.resolve();
    });
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

  /** The committed etag sidecar `fileName`, parsed, or `{}` if none. */
  function writtenEtags(fileName: string): Record<string, Record<string, string>> {
    for (const [path, content] of disk) {
      if (path.endsWith(fileName)) return JSON.parse(content);
    }
    return {};
  }

  /** Emits each chunk in order on one stream, then closes with exit 0. */
  function spawnEmitting(stream: 'stdout' | 'stderr', chunks: readonly Buffer[]): MockChildProcess {
    const proc = new MockChildProcess();
    setTimeout(() => {
      for (const chunk of chunks) proc[stream].emit('data', chunk);
      proc.emit('close', 0, null);
    }, 5);
    return proc;
  }

  it('successfully syncs daily CUR files', async () => {
    const proc = createSuccessfulSpawn();
    mockSpawn.mockReturnValue(proc);

    const files = [
      file('cur/data/billing_period=2026-03/file1.parquet', 'hash1'),
      file('cur/data/billing_period=2026-03/file2.parquet', 'hash2'),
    ];

    const dataDir = join('/tmp', 'test');
    const expectedDest = join(dataDir, 'aws', 'raw', 'daily-2026-03');

    const result = await syncSelectedFiles({
      bucketPath: 's3://test-bucket/cur/data/',
      profile: 'test-profile',
      providerName,
      dataDir,
      expectedDataType: 'daily',
      files,
    });

    expect(result.filesDownloaded).toBe(2);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringContaining('aws'),
      ['s3', 'sync', 's3://test-bucket/cur/data/billing_period=2026-03/', expectedDest, '--exclude', '*', '--include', '*.parquet', '--profile', 'test-profile'],
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
      providerName,
      dataDir: '/tmp/test',
      expectedDataType: 'cost-optimization',
      files,
    });

    expect(result.filesDownloaded).toBe(2);
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('refuses to mirror the whole bucket when no key has a period folder', async () => {
    // Flat keys → extractPeriodPrefix('') → source would collapse to
    // `s3://bucket/` and `aws s3 sync` would pull the entire bucket. The guard
    // must skip them all and fail loudly, never spawning the sync.
    mockSpawn.mockImplementation(() => createSuccessfulSpawn());
    const files = [file('flatfile1.parquet', 'h1'), file('nested/flatfile2.parquet', 'h2')];

    await expect(syncSelectedFiles({
      bucketPath: 's3://test-bucket/',
      profile: 'test-profile',
      providerName,
      dataDir: '/tmp/test',
      expectedDataType: 'daily',
      files,
    })).rejects.toThrow(/billing_period=/);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('skips a flat-layout period but still syncs the valid ones', async () => {
    mockSpawn.mockImplementation(() => createSuccessfulSpawn());
    mockReaddir.mockResolvedValue(['data.parquet']);
    const files = [
      file('cur/billing_period=2026-03/a.parquet', 'h1'),
      file('flat.parquet', 'h2'), // groups under 'unknown' → skipped, not mirrored
    ];

    const result = await syncSelectedFiles({
      bucketPath: 's3://test-bucket/',
      profile: 'test-profile',
      providerName,
      dataDir: '/tmp/test',
      expectedDataType: 'daily',
      files,
    });

    // Only the valid period was synced; the flat one was skipped.
    expect(result.filesDownloaded).toBe(1);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringContaining('aws'),
      expect.arrayContaining(['s3://test-bucket/cur/billing_period=2026-03/']),
      expect.anything(),
    );
  });

  it('handles multiple periods in sorted order', async () => {
    mockSpawn.mockImplementation(() => createSuccessfulSpawn());

    const files = [
      file('cur/billing_period=2026-01/a.parquet', 'h1'),
      file('cur/billing_period=2026-03/b.parquet', 'h2'),
      file('cur/billing_period=2026-02/c.parquet', 'h3'),
    ];

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      providerName,
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

    const files = [file('cur/billing_period=2026-03/file1.parquet')];
    const progressEvents: SyncProgress[] = [];

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      providerName,
      dataDir: '/tmp',
      files,
      onProgress: (progress) => { progressEvents.push(progress); },
    });

    expect(progressEvents.some((p) => p.phase === 'downloading')).toBe(true);
    expect(progressEvents.some((p) => p.phase === 'done')).toBe(true);
    expect(progressEvents.some((p) => p.message?.includes('Completed'))).toBe(true);
  });

  it('rejects when AWS CLI is not found', async () => {
    const proc = new MockChildProcess();
    setTimeout(() => { proc.emit('error', new Error('spawn aws ENOENT')); }, 10);
    mockSpawn.mockReturnValue(proc);

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        files: [file('cur/billing_period=2026-03/file.parquet')],
      })
    ).rejects.toThrow('AWS CLI not found');
  });

  it('rejects without spawning when no trusted AWS CLI install exists', async () => {
    // A miss must disable the feature, not degrade to a bare-name spawn that
    // PATH order — and therefore a writable early PATH entry — would resolve.
    mockFindAwsCli.mockReturnValueOnce(null);

    await expect(
      syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        files: [file('cur/billing_period=2026-03/file.parquet')],
      })
    ).rejects.toThrow('AWS CLI not found');
    expect(mockSpawn).not.toHaveBeenCalled();
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
        providerName,
        dataDir: '/tmp',
        files: [file('cur/billing_period=2026-03/file.parquet')],
      })
    ).rejects.toThrow(expectedMessage);
  });

  it('cancels sync when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      providerName,
      dataDir: '/tmp',
      files: [file('cur/billing_period=2026-03/file.parquet')],
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
        providerName,
        dataDir: '/tmp',
        files: [file('cur/billing_period=2026-03/file.parquet')],
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
        providerName,
        dataDir: '/tmp',
        files: [
          file('cur/billing_period=2026-01/a.parquet'),
          file('cur/billing_period=2026-02/b.parquet'),
          file('cur/billing_period=2026-03/c.parquet'),
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

    const dataDir = '/tmp';
    const expectedEtagFile = join(dataDir, 'aws', 'meta', 'sync-etags.json');
    disk.set(expectedEtagFile, JSON.stringify({ '2026-01': { 'old-file.parquet': 'old-hash' } }));

    await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      providerName,
      dataDir,
      files: [file('cur/billing_period=2026-02/new-file.parquet', 'new-hash')],
    });

    expect(JSON.parse(disk.get(expectedEtagFile) ?? '{}')).toEqual({
      '2026-01': { 'old-file.parquet': 'old-hash' },
      '2026-02': { 'cur/billing_period=2026-02/new-file.parquet': 'new-hash' },
    });
  });

  describe('stale-file pruning', () => {
    it('deletes local parquet no longer in the current manifest', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      // Staging dir holds the two current parts plus a leftover from a prior export.
      mockReaddir.mockResolvedValue(['file1.parquet', 'file2.parquet', 'stale-old-part.parquet']);

      const files = [
        file('cur/data/billing_period=2026-03/file1.parquet', 'h1'),
        file('cur/data/billing_period=2026-03/file2.parquet', 'h2'),
      ];
      const dataDir = join('/tmp', 'prune-test');
      const dest = join(dataDir, 'aws', 'raw', 'daily-2026-03');

      await syncSelectedFiles({
        bucketPath: 's3://test-bucket/cur/data/',
        profile: 'test-profile',
        providerName,
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
        providerName,
        dataDir: '/tmp/prune-clean',
        expectedDataType: 'daily',
        files: [
          file('cur/data/billing_period=2026-03/file1.parquet'),
          file('cur/data/billing_period=2026-03/file2.parquet'),
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
        providerName,
        dataDir: '/tmp/prune-temp',
        expectedDataType: 'daily',
        files: [file('cur/data/billing_period=2026-03/file1.parquet')],
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
        providerName,
        dataDir,
        expectedDataType: 'daily',
        files: [file('cur/data/billing_period=2026-03/file1.parquet')],
      });

      // Download succeeded and etags were still persisted despite the prune error.
      expect(result.filesDownloaded).toBe(1);
      expect(disk.has(join(dataDir, 'aws', 'meta', 'sync-etags.json'))).toBe(true);
    });

    it('does not prune when the period sync fails', async () => {
      mockSpawn.mockReturnValue(createFailedSpawn(1, 'Access Denied'));
      mockReaddir.mockResolvedValue(['stale.parquet']);

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://test-bucket/cur/data/',
          profile: 'test-profile',
          providerName,
          dataDir: '/tmp/prune-fail',
          expectedDataType: 'daily',
          files: [file('cur/data/billing_period=2026-03/file1.parquet')],
        })
      ).rejects.toThrow('Access Denied');

      expect(mockRm).not.toHaveBeenCalled();
    });
  });

  it('handles empty file list', async () => {
    const result = await syncSelectedFiles({
      bucketPath: 's3://bucket/cur/',
      profile: 'test',
      providerName,
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
      providerName,
      dataDir,
      files: [file('cur/billing_period=2026-03/file.parquet')],
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
        providerName,
        dataDir: '/tmp',
        files: [
          file('cur/billing_period=2026-01/a.parquet'),
          file('cur/billing_period=2026-02/b.parquet'),
          file('cur/billing_period=2026-03/c.parquet'),
        ],
      })
    ).rejects.toThrow('Connection timed out');

    expect(spawnCount).toBe(2);
  });

  describe('per-period orchestration', () => {
    it('saves ETags after each period completes', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        files: [
          file('cur/billing_period=2026-01/a.parquet', 'hash-jan'),
          file('cur/billing_period=2026-02/b.parquet', 'hash-feb'),
          file('cur/billing_period=2026-03/c.parquet', 'hash-mar'),
        ],
      });

      expect(mockWriteFile).toHaveBeenCalledTimes(3);

      const saved = writtenEtags('sync-etags.json');
      expect(saved['2026-01']?.['cur/billing_period=2026-01/a.parquet']).toBe('hash-jan');
      expect(saved['2026-02']?.['cur/billing_period=2026-02/b.parquet']).toBe('hash-feb');
      expect(saved['2026-03']?.['cur/billing_period=2026-03/c.parquet']).toBe('hash-mar');
    });

    it('processes periods sequentially', async () => {
      const spawnOrder: string[] = [];

      mockSpawn.mockImplementation((_cmd: unknown, rawArgs: unknown) => {
        const args = rawArgs as string[];
        const period = args.find((arg) => arg.includes('billing_period='))?.match(/2026-\d{2}/)?.[0];
        if (period !== undefined) spawnOrder.push(period);

        const proc = new MockChildProcess();
        setTimeout(() => { proc.emit('close', 0, null); }, 10);
        return proc;
      });

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cur/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        files: [
          file('cur/billing_period=2026-01/a.parquet'),
          file('cur/billing_period=2026-02/b.parquet'),
          file('cur/billing_period=2026-03/c.parquet'),
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
          providerName,
          dataDir: '/tmp',
          files: [
            file('cur/billing_period=2026-01/a.parquet'),
            file('cur/billing_period=2026-02/b.parquet'),
            file('cur/billing_period=2026-03/c.parquet'),
          ],
        })
      ).rejects.toThrow('Access Denied for period 2');

      expect(spawnCount).toBe(2);
      expect(Object.keys(writtenEtags('sync-etags.json'))).toEqual(['2026-01']);
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
        providerName,
        dataDir: '/tmp',
        files: [
          file('cur/billing_period=2026-01/a.parquet'),
          file('cur/billing_period=2026-01/b.parquet'),
          file('cur/billing_period=2026-02/c.parquet'),
          file('cur/billing_period=2026-02/d.parquet'),
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

    it('handles abort between periods — saves completed period ETags only', async () => {
      const controller = new AbortController();
      let spawnCount = 0;

      mockWriteFile.mockImplementation((path: unknown, content: unknown) => {
        // The user cancels while period 1's etags are being saved.
        if (String(path).includes('sync-etags.json') && spawnCount === 1) controller.abort();
        disk.set(String(path), String(content));
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
        providerName,
        dataDir: '/tmp',
        files: [
          file('cur/billing_period=2026-01/a.parquet'),
          file('cur/billing_period=2026-02/b.parquet'),
          file('cur/billing_period=2026-03/c.parquet'),
        ],
        signal: controller.signal,
      });

      expect(result.filesDownloaded).toBe(1);
      expect(spawnCount).toBe(1);
      expect(Object.keys(writtenEtags('sync-etags.json'))).toEqual(['2026-01']);
    });
  });

  describe('cost-optimization sync', () => {
    it('groups files by date and syncs each', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      mockReaddir.mockResolvedValue(['file1.parquet', 'file2.parquet']);

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        providerName,
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
        providerName,
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
        providerName,
        dataDir: '/tmp/test',
        expectedDataType: 'cost-optimization',
        files: [file('cost-opt/date=2026-03-15/file.parquet', 'h1')],
      });

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining('aws'),
        ['s3', 'sync', 's3://test-bucket/cost-opt/date=2026-03-15/', expect.stringContaining('cost-opt-2026-03-15'), '--exclude', '*', '--include', '*.parquet', '--profile', 'prod-profile'],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
    });

    it('writes raw cost-opt dirs and removes the legacy hive copy', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      const dataDir = '/data/test';

      await syncSelectedFiles({
        bucketPath: 's3://bucket/cost-opt/',
        profile: 'test',
        providerName,
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
        providerName,
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
        providerName,
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
      // Only the date that actually downloaded is recorded as current: the two
      // never-fetched dates must stay stale so the next run retries them.
      expect(writtenEtags('sync-etags-cost-optimization.json')).toEqual({
        '2026-03': { 'cost-opt/date=2026-03-15/file1.parquet': 'h' },
      });
    });

    it('rejects on permission denied', async () => {
      const proc = createFailedSpawn(1, 'An error occurred (403) when calling the GetObject operation: Forbidden');
      mockSpawn.mockReturnValue(proc);
      mockReaddir.mockResolvedValue(['data.parquet']);

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cost-opt/',
          profile: 'test',
          providerName,
          dataDir: '/tmp',
          expectedDataType: 'cost-optimization',
          files: [file('cost-opt/date=2026-03-15/file.parquet')],
        })
      ).rejects.toThrow('Forbidden');
    });
  });

  describe('partition prefix validation', () => {
    it('refuses a cost-opt run whose only key has date= in the FILE name', async () => {
      // `date=2026-01-01_part-0.parquet` used to yield the prefix '': the
      // source collapsed to `s3://b/` and the whole bucket was mirrored.
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      await expect(syncSelectedFiles({
        bucketPath: 's3://b/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        expectedDataType: 'cost-optimization',
        files: [file('cost-opt/date=2026-01-01_part-0.parquet')],
      })).rejects.toThrow(/date=YYYY-MM-DD\//);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(writtenEtags('sync-etags-cost-optimization.json')).toEqual({});
    });

    it('syncs the date folder but never stamps a flat key of the same date', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      const result = await syncSelectedFiles({
        bucketPath: 's3://b/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        expectedDataType: 'cost-optimization',
        files: [
          file('cost-opt/date=2026-01-01_part-0.parquet', 'flat'),
          file('cost-opt/date=2026-01-01/a.parquet', 'folder'),
        ],
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['s3://b/cost-opt/date=2026-01-01/']));
      expect(result.filesDownloaded).toBe(1);
      expect(writtenEtags('sync-etags-cost-optimization.json')).toEqual({
        '2026-01': { 'cost-opt/date=2026-01-01/a.parquet': 'folder' },
      });
    });

    it('still syncs the valid folder when a -v2 lookalike is listed first', async () => {
      // '-' sorts before '/', so a first-file guard would have dropped the
      // real folder along with the lookalike.
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      const result = await syncSelectedFiles({
        bucketPath: 's3://b/cost-opt/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        expectedDataType: 'cost-optimization',
        files: [
          file('cost-opt/date=2026-01-01-v2/a.parquet'),
          file('cost-opt/date=2026-01-01/a.parquet'),
        ],
      });

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['s3://b/cost-opt/date=2026-01-01/']));
      expect(result.filesDownloaded).toBe(1);
    });

    it('syncs one prefix per period and records only the files under it', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      const result = await syncSelectedFiles({
        bucketPath: 's3://b/',
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        expectedDataType: 'daily',
        files: [
          file('b/billing_period=2026-01/y.parquet', 'hy'),
          file('a/billing_period=2026-01/x.parquet', 'hx'),
        ],
      });

      // Two prefixes into one raw/daily-2026-01 dir would double-count: the
      // lexicographically smallest wins and the other is left stale.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['s3://b/a/billing_period=2026-01/']));
      expect(result.filesDownloaded).toBe(1);
      expect(writtenEtags('sync-etags.json')).toEqual({
        '2026-01': { 'a/billing_period=2026-01/x.parquet': 'hx' },
      });
    });

    it.each([
      ['cost-optimization', 's3://b/cost-opt/', 'other/date=2026-03-15/x.parquet', /date=YYYY-MM-DD\//],
      ['daily', 's3://b/cur/', 'secret/billing_period=2026-01/x.parquet', /billing_period=YYYY-MM\//],
    ] as const)('refuses a %s key outside the configured prefix', async (tier, bucketPath, key, message) => {
      // Keys reach this function over IPC from the renderer; a key the
      // listing under the bucket path could never have returned is rejected.
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      await expect(syncSelectedFiles({
        bucketPath,
        profile: 'test',
        providerName,
        dataDir: '/tmp',
        expectedDataType: tier,
        files: [file(key)],
      })).rejects.toThrow(message);

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('passes the Parquet-only filters after the positional args, in order', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());

      await syncSelectedFiles({
        bucketPath: 's3://b/cur/',
        profile: 'p',
        providerName,
        dataDir: '/tmp',
        files: [file('cur/billing_period=2026-03/x.parquet')],
      });

      // Later filters win: exclude everything, then re-include only Parquet.
      expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
        's3', 'sync', 's3://b/cur/billing_period=2026-03/', expect.any(String),
        '--exclude', '*', '--include', '*.parquet', '--profile', 'p',
      ]);
    });
  });

  describe('aws output parsing (#454)', () => {
    const daily = {
      bucketPath: 's3://b/cur/',
      profile: 'p',
      providerName,
      dataDir: '/tmp',
      files: [file('cur/billing_period=2026-03/x.parquet')],
    };

    function downloadingEvents(events: readonly SyncProgress[]): SyncProgress[] {
      return events.filter(e => e.phase === 'downloading');
    }

    it('counts a download line split across two chunks once', async () => {
      mockSpawn.mockReturnValue(spawnEmitting('stdout', [
        Buffer.from('download: s3://b/cur/billing_period=2026-03/x.parq'),
        Buffer.from('uet to /tmp/x.parquet\n'),
      ]));
      const events: SyncProgress[] = [];

      await syncSelectedFiles({ ...daily, onProgress: (p) => { events.push(p); } });

      const downloading = downloadingEvents(events);
      expect(downloading).toHaveLength(1);
      expect(downloading[0]?.filesDone).toBe(1);
    });

    it('reads a CR-terminated progress line split across chunks', async () => {
      mockSpawn.mockReturnValue(spawnEmitting('stdout', [
        Buffer.from('Completed 1.0 MiB/2.0 Mi'),
        Buffer.from('B (1.0 MiB/s) with 1 file(s) remaining\r'),
      ]));
      const events: SyncProgress[] = [];

      await syncSelectedFiles({ ...daily, onProgress: (p) => { events.push(p); } });

      const downloading = downloadingEvents(events);
      expect(downloading).toHaveLength(1);
      expect(downloading[0]?.bytesDone).toBe(1024 * 1024);
      expect(downloading[0]?.bytesTotal).toBe(2 * 1024 * 1024);
    });

    it('counts a download that follows a CR progress line in the same chunk', async () => {
      // aws-cli 2.x redraws progress with a bare CR, so the download line
      // shares a "line" with it unless CR is a line break.
      mockSpawn.mockReturnValue(spawnEmitting('stdout', [
        Buffer.from('Completed 1.0 MiB/2.0 MiB (1.0 MiB/s) with 1 file(s) remaining\rdownload: s3://b/cur/billing_period=2026-03/x.parquet to /tmp/x.parquet\n'),
      ]));
      const events: SyncProgress[] = [];

      await syncSelectedFiles({ ...daily, onProgress: (p) => { events.push(p); } });

      expect(downloadingEvents(events).at(-1)?.filesDone).toBe(1);
    });

    it('logs a path split mid-code-point intact', async () => {
      const line = Buffer.from('download: s3://b/cur/billing_period=2026-03/café.parquet to /tmp/café.parquet\n');
      const split = line.indexOf(Buffer.from('é')) + 1; // inside the 2-byte é
      mockSpawn.mockReturnValue(spawnEmitting('stdout', [line.subarray(0, split), line.subarray(split)]));

      const info = vi.spyOn(logger, 'info');

      await syncSelectedFiles(daily);

      const logged = info.mock.calls.map(c => c[0]);
      expect(logged).toContain('[aws] download: s3://b/cur/billing_period=2026-03/café.parquet to /tmp/café.parquet');
    });

    it('flushes an unterminated final line when the process closes', async () => {
      mockSpawn.mockReturnValue(spawnEmitting('stdout', [
        Buffer.from('download: s3://b/cur/billing_period=2026-03/x.parquet to /tmp/x.parquet'),
      ]));
      const events: SyncProgress[] = [];

      await syncSelectedFiles({ ...daily, onProgress: (p) => { events.push(p); } });

      expect(downloadingEvents(events).at(-1)?.filesDone).toBe(1);
    });

    it('keeps a stderr failure split across chunks whole in the error', async () => {
      const proc = new MockChildProcess();
      setTimeout(() => {
        proc.stderr.emit('data', Buffer.from('fatal error: An error occurred (AccessDe'));
        proc.stderr.emit('data', Buffer.from('nied) when calling the ListObjectsV2 operation'));
        proc.emit('close', 1, null);
      }, 5);
      mockSpawn.mockReturnValue(proc);

      await expect(syncSelectedFiles(daily)).rejects.toThrow('(AccessDenied) when calling the ListObjectsV2 operation');
    });

    it('detaches its abort listener once each sync succeeds', async () => {
      mockSpawn.mockImplementation(() => createSuccessfulSpawn());
      const controller = new AbortController();

      await syncSelectedFiles({
        ...daily,
        files: [file('cur/billing_period=2026-01/a.parquet'), file('cur/billing_period=2026-02/b.parquet')],
        signal: controller.signal,
      });

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
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
          providerName,
          dataDir: '/tmp',
          files: [file('cur/billing_period=2026-03/file.parquet')],
        })
      ).rejects.toThrow('ENOSPC');
    });

    it('rejects when staging directory creation fails', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

      await expect(
        syncSelectedFiles({
          bucketPath: 's3://bucket/cur/',
          profile: 'test',
          providerName,
          dataDir: '/tmp',
          files: [file('cur/billing_period=2026-03/file.parquet')],
        })
      ).rejects.toThrow('ENOSPC: no space left on device');
    });

    it('saves ETags for completed periods before failure', async () => {
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
          providerName,
          dataDir: '/tmp',
          files: [
            file('cur/billing_period=2026-01/a.parquet', 'hash-jan'),
            file('cur/billing_period=2026-02/b.parquet', 'hash-feb'),
          ],
        })
      ).rejects.toThrow('ENOSPC');

      const saved = writtenEtags('sync-etags.json');
      expect(saved['2026-01']?.['cur/billing_period=2026-01/a.parquet']).toBe('hash-jan');
      expect(saved['2026-02']).toBeUndefined();
    });
  });
});
