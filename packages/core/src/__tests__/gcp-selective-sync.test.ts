import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { syncGcpSelectedFiles, parseGcloudCompletedBytes } from '../sync/gcp-selective-sync.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import type { SyncProgress } from '../sync/s3-client.js';
import { asProviderName } from '../types/branded.js';

/** Unlike `selective-sync.test.ts`, this suite does NOT mock `node:fs` — the
 *  behaviour worth pinning is the real directory swap: what `raw/` looks like
 *  after a success, an abort, and a canonicalize failure. Only the `gcloud`
 *  subprocess is faked, standing in for bytes landing in the staging dir. */
vi.mock('node:child_process');
vi.mock('../logger/logger.js');

const providerName = asProviderName('gcp-main');

const file = (key: string, hash = 'h', size = 10): ManifestFileEntry => ({ key, contentHash: hash, size });

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

/** Write a BigQuery-export-shaped shard where the fake `gcloud` would have
 *  put one, so the canonicalizer downstream has real Parquet to read. */
async function writeBqShard(dir: string, rows: number): Promise<void> {
  const instance = await DuckDBInstance.create();
  const conn = await instance.connect();
  await mkdir(dir, { recursive: true });
  await conn.run(`COPY (
    SELECT
      TIMESTAMPTZ '2026-01-15 08:00:00+00' AS ChargePeriodStart,
      'proj-a' AS SubAccountId, 'Project A' AS SubAccountName,
      CAST(1.5 AS DECIMAL(38,9)) AS BilledCost, CAST(1.5 AS DECIMAL(38,9)) AS EffectiveCost,
      CAST(3.0 AS DECIMAL(38,9)) AS ListCost, CAST(1.5 AS DECIMAL(38,9)) AS ContractedCost,
      'Compute Engine' AS ServiceName, 'Compute' AS ServiceCategory,
      'europe-west1' AS RegionId, '//compute/x' AS ResourceId,
      'Usage' AS ChargeCategory, 'Standard' AS PricingCategory,
      'desc' AS ChargeDescription, CAST(1 AS DECIMAL(38,9)) AS ConsumedQuantity,
      [{'Key': 'team', 'Value': 'platform'}] AS Tags,
      'compute.googleapis.com' AS x_ServiceId
    FROM range(${String(rows)})
  ) TO '${join(dir, 'shard-000000000000.parquet')}' (FORMAT PARQUET)`);
}

describe('syncGcpSelectedFiles', () => {
  let dataDir: string;
  let mockSpawn: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;

  /** Drive the next spawned process: `onSpawn` receives the destination
   *  directory the CLI was told to write into, so a case can materialize
   *  shards (or not) before signalling completion. */
  function nextProcess(onSpawn: (dest: string) => Promise<void>, exitCode = 0): void {
    mockSpawn.mockImplementationOnce((_bin: unknown, args: unknown) => {
      const proc = new MockChildProcess();
      const argv = Array.isArray(args) ? args.map(String) : [];
      const dest = argv[3] ?? '';
      queueMicrotask(() => {
        void onSpawn(dest).then(() => {
          proc.stderr.emit('data', Buffer.from('Completed files 1/1 | 10.0B/10.0B\n'));
          proc.emit('close', exitCode, null);
        });
      });
      return proc;
    });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), 'gcp-sync-'));
    const childProcess = await import('node:child_process');
    mockSpawn = vi.fn<(...args: unknown[]) => unknown>();
    childProcess.spawn = mockSpawn as typeof childProcess.spawn;
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  const rawPeriodDir = (period: string): string => join(dataDir, String(providerName), 'raw', `daily-${period}`);
  const etagPath = (): string => join(dataDir, String(providerName), 'meta', 'sync-etags.json');

  it('downloads, canonicalizes and installs a period, then records its etags', async () => {
    nextProcess(dest => writeBqShard(dest, 3));

    const files = [file('focus/billing_period=2026-01/shard-000000000000.parquet', 'crc-1')];
    const result = await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, files,
    });

    expect(result.filesDownloaded).toBe(1);
    expect(result.rowsProcessed).toBe(3);

    // The installed period is the canonicalized single file, not the shards.
    expect(await readdir(rawPeriodDir('2026-01'))).toEqual(['part-0.parquet']);

    const etags: unknown = JSON.parse(await readFile(etagPath(), 'utf-8'));
    expect(etags).toEqual({
      '2026-01': { 'focus/billing_period=2026-01/shard-000000000000.parquet': 'crc-1' },
    });
  });

  it('passes the period prefix as the rsync source and stages outside raw/', async () => {
    let observedArgv: string[] = [];
    mockSpawn.mockImplementationOnce((_bin: unknown, args: unknown) => {
      const proc = new MockChildProcess();
      observedArgv = Array.isArray(args) ? args.map(String) : [];
      const dest = observedArgv[3] ?? '';
      queueMicrotask(() => { void writeBqShard(dest, 1).then(() => { proc.emit('close', 0, null); }); });
      return proc;
    });

    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-03/shard-000000000000.parquet')],
    });

    expect(observedArgv[0]).toBe('storage');
    expect(observedArgv[1]).toBe('rsync');
    expect(observedArgv[2]).toBe('gs://focus-export/focus/billing_period=2026-03/');
    // Staging under raw/ would be picked up by the query layer's
    // raw/{tier}-*/*.parquet glob mid-sync, mixing export shards into a read.
    expect(observedArgv[3]).not.toContain(join('raw', 'daily-'));
    expect(observedArgv[3]).toContain(join('meta', 'staging-gcp', '2026-03'));
    // Mirrors deletions so a re-export with fewer shards leaves no orphans.
    expect(observedArgv).toContain('--delete-unmatched-destination-objects');
  });

  it('removes the staging directory once the period is installed', async () => {
    nextProcess(dest => writeBqShard(dest, 1));
    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet')],
    });
    const stagingRoot = join(dataDir, String(providerName), 'meta', 'staging-gcp');
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
  });

  it('leaves an already-installed period untouched when the download fails', async () => {
    // Install 2026-01 first, then fail a re-sync of it.
    nextProcess(dest => writeBqShard(dest, 2));
    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet', 'crc-1')],
    });
    const before = await readFile(join(rawPeriodDir('2026-01'), 'part-0.parquet'));

    mockSpawn.mockImplementationOnce(() => {
      const proc = new MockChildProcess();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from('Max retries exceeded\n'));
        proc.emit('close', 1, null);
      });
      return proc;
    });

    await expect(syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet', 'crc-2')],
    })).rejects.toThrow(/gcloud storage rsync failed/);

    // Byte-identical: a failed sync must never leave a period half-replaced.
    expect(await readFile(join(rawPeriodDir('2026-01'), 'part-0.parquet'))).toEqual(before);
    // And the old etag stands, so the period still reads as stale and retries.
    const etags: unknown = JSON.parse(await readFile(etagPath(), 'utf-8'));
    expect(etags).toEqual({ '2026-01': { 'focus/billing_period=2026-01/s.parquet': 'crc-1' } });
  });

  it('does not install a period, or its etags, when canonicalization fails', async () => {
    // Shards that are not a FOCUS export at all.
    nextProcess(async (dest) => {
      await mkdir(dest, { recursive: true });
      await writeFile(join(dest, 'shard-000000000000.parquet'), 'not parquet');
    });

    await expect(syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet')],
    })).rejects.toThrow();

    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow();
    await expect(readFile(etagPath(), 'utf-8')).rejects.toThrow();
  });

  it('stops at the first failing period, keeping earlier periods and their etags', async () => {
    nextProcess(dest => writeBqShard(dest, 1));
    mockSpawn.mockImplementationOnce(() => {
      const proc = new MockChildProcess();
      queueMicrotask(() => { proc.emit('close', 1, null); });
      return proc;
    });

    await expect(syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [
        file('focus/billing_period=2026-01/s.parquet', 'crc-jan'),
        file('focus/billing_period=2026-02/s.parquet', 'crc-feb'),
      ],
    })).rejects.toThrow();

    expect(await readdir(rawPeriodDir('2026-01'))).toEqual(['part-0.parquet']);
    await expect(readdir(rawPeriodDir('2026-02'))).rejects.toThrow();
    const etags: unknown = JSON.parse(await readFile(etagPath(), 'utf-8'));
    expect(etags).toEqual({ '2026-01': { 'focus/billing_period=2026-01/s.parquet': 'crc-jan' } });
  });

  it('does nothing when aborted before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet')],
      signal: controller.signal,
    });
    expect(result).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('rejects with the cancellation message when aborted mid-download', async () => {
    const controller = new AbortController();
    mockSpawn.mockImplementationOnce(() => {
      const proc = new MockChildProcess();
      queueMicrotask(() => { controller.abort(); });
      return proc;
    });

    await expect(syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet')],
      signal: controller.signal,
    })).rejects.toThrow('Download cancelled');
    // The handlers string-match this exact message to render "cancelled"
    // rather than a failure, and `raw/` must be untouched either way.
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow();
  });

  it('reports an exact byte total from the listing, before any CLI output', async () => {
    const progress: SyncProgress[] = [];
    nextProcess(dest => writeBqShard(dest, 1));

    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/billing_period=2026-01/s.parquet', 'h', 4096)],
      onProgress: (p) => { progress.push(p); },
    });

    // Unlike the AWS path, which has to scrape a total out of CLI stdout.
    expect(progress.every(p => p.bytesTotal === 4096 || p.bytesTotal === undefined)).toBe(true);
    expect(progress.some(p => p.phase === 'repartitioning')).toBe(true);
    const last = progress.at(-1);
    expect(last?.phase).toBe('done');
    expect(last?.bytesDone).toBe(4096);
  });

  it('skips keys with no recognizable billing period rather than syncing them somewhere odd', async () => {
    const result = await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir,
      files: [file('focus/BILLING_PERIOD=2026-01/s.parquet'), file('focus/loose.parquet')],
    });
    expect(result.filesDownloaded).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('parseGcloudCompletedBytes', () => {
  it('reads the byte pair out of a gcloud progress line', () => {
    expect(parseGcloudCompletedBytes('Completed files 3/10 | 12.0MiB/40.0MiB'))
      .toEqual({ bytesDone: 12 * 1024 * 1024, bytesTotal: 40 * 1024 * 1024 });
    // gcloud spells the kibibyte unit differently from the AWS CLI.
    expect(parseGcloudCompletedBytes('Completed files 1/1 | 512.0kiB/1.0MiB'))
      .toEqual({ bytesDone: 512 * 1024, bytesTotal: 1024 * 1024 });
  });

  it('returns null for lines without a byte pair, so the last numbers stand', () => {
    expect(parseGcloudCompletedBytes('Copying gs://bucket/obj to file://tmp/obj')).toBeNull();
    expect(parseGcloudCompletedBytes('Completed files 3/10')).toBeNull();
    expect(parseGcloudCompletedBytes('')).toBeNull();
    // A zero total would make the progress fraction a division by zero.
    expect(parseGcloudCompletedBytes('Completed files 0/0 | 0.0B/0.0B')).toBeNull();
  });
});
