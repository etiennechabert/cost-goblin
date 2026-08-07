import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { syncGcpSelectedFiles, parseGcloudCompletedBytes, parseGcloudCopyingKey } from '../sync/gcp-selective-sync.js';
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily', files,
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

  it('installs the hourly tier into raw/hourly-* with its own etag file', async () => {
    // The GCP FOCUS export is delivered at hourly grain and the exporter
    // publishes both grains from it, so a GCP provider can carry a real
    // hourly tier. Hardcoding 'daily' here would land intraday rows in
    // raw/daily-*, where the daily views would then double-count them
    // alongside the rolled-up daily tier reading the same months.
    nextProcess(dest => writeBqShard(dest, 2));

    const result = await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus/hourly', providerName, dataDir, expectedDataType: 'hourly',
      files: [file('focus/hourly/billing_period=2026-01/shard-000000000000.parquet', 'crc-h')],
    });

    expect(result.rowsProcessed).toBe(2);
    expect(await readdir(join(dataDir, String(providerName), 'raw', 'hourly-2026-01'))).toEqual(['part-0.parquet']);
    // The daily tier's directory and etag file are untouched — the two tiers
    // track their periods independently.
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow();
    const etags: unknown = JSON.parse(
      await readFile(join(dataDir, String(providerName), 'meta', 'sync-etags-hourly.json'), 'utf-8'),
    );
    expect(etags).toEqual({
      '2026-01': { 'focus/hourly/billing_period=2026-01/shard-000000000000.parquet': 'crc-h' },
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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

  it('runs gcloud as the impersonated service account when one is configured', async () => {
    // ADC impersonation covers the listing SDK but NOT the CLI, which uses
    // gcloud's own signed-in identity. Without this flag the two halves of a
    // sync authenticate as different principals and the least-privilege
    // service account is bypassed for the half that moves the data.
    let argv: string[] = [];
    mockSpawn.mockImplementationOnce((_bin: unknown, args: unknown) => {
      const proc = new MockChildProcess();
      argv = Array.isArray(args) ? args.map(String) : [];
      const dest = argv.find(a => a.includes('staging-gcp')) ?? '';
      queueMicrotask(() => { void writeBqShard(dest, 1).then(() => { proc.emit('close', 0, null); }); });
      return proc;
    });

    await syncGcpSelectedFiles({
      bucketPath: 'gs://b/focus', providerName, dataDir, expectedDataType: 'daily',
      impersonateServiceAccount: 'costgoblin-reader@p.iam.gserviceaccount.com',
      files: [file('focus/billing_period=2026-01/s.parquet')],
    });

    expect(argv).toContain('--impersonate-service-account=costgoblin-reader@p.iam.gserviceaccount.com');
  });

  it('omits the impersonation flag entirely when none is configured', async () => {
    let argv: string[] = [];
    mockSpawn.mockImplementationOnce((_bin: unknown, args: unknown) => {
      const proc = new MockChildProcess();
      argv = Array.isArray(args) ? args.map(String) : [];
      const dest = argv[3] ?? '';
      queueMicrotask(() => { void writeBqShard(dest, 1).then(() => { proc.emit('close', 0, null); }); });
      return proc;
    });
    await syncGcpSelectedFiles({
      bucketPath: 'gs://b/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file('focus/billing_period=2026-01/s.parquet')],
    });
    expect(argv.some(a => a.startsWith('--impersonate-service-account'))).toBe(false);
  });

  it('removes the staging directory once the period is installed', async () => {
    nextProcess(dest => writeBqShard(dest, 1));
    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file('focus/billing_period=2026-01/s.parquet')],
    });
    const stagingRoot = join(dataDir, String(providerName), 'meta', 'staging-gcp');
    await expect(readdir(stagingRoot)).resolves.toEqual([]);
  });

  it('skips a period whose key is not under a billing_period folder, instead of mirroring the bucket', async () => {
    // `extractPeriod` matches `billing_period=2026-01` anywhere in the key, but
    // `extractPeriodPrefix` needs a trailing slash and returns '' without one.
    // The source would then collapse to `gs://focus-export/` and rsync would
    // pull the WHOLE bucket into this one period's staging dir.
    const result = await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file('focus/billing_period=2026-01_shard0.parquet', 'crc-1')],
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result.filesDownloaded).toBe(0);
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow();
  });

  it('keeps gcloud progress lines out of the failure message', async () => {
    // gcloud writes progress to stderr, so the raw buffer carries byte counts.
    // A `503.1MiB` aggregate previously reached `isGcloudDownloadFailure`,
    // whose `503` marker then reported a permission error as an expired session.
    mockSpawn.mockImplementationOnce(() => {
      const proc = new MockChildProcess();
      queueMicrotask(() => {
        proc.stderr.emit('data', Buffer.from(
          'Copying gs://focus-export/focus/billing_period=2026-01/s.parquet to file:///tmp/s.parquet\n'
          + '....\n'
          + 'Completed files 12/50 | 503.1MiB/1.2GiB\n'
          + 'Average throughput: 40.0MiB/s\n'
          + "ERROR: (gcloud.storage.rsync) User does not have storage.objects.get access.\n",
        ));
        proc.emit('close', 1, null);
      });
      return proc;
    });

    const failure = await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file('focus/billing_period=2026-01/s.parquet')],
    }).catch((err: unknown) => (err instanceof Error ? err.message : String(err)));

    expect(failure).toContain('storage.objects.get');
    expect(failure).not.toContain('503');
    expect(failure).not.toContain('Copying gs://');
    expect(failure).not.toContain('Average throughput');
  });

  it('leaves an already-installed period untouched when the download fails', async () => {
    // Install 2026-01 first, then fail a re-sync of it.
    nextProcess(dest => writeBqShard(dest, 2));
    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file('focus/billing_period=2026-01/s.parquet')],
      signal: controller.signal,
    })).rejects.toThrow('Download cancelled');
    // The handlers string-match this exact message to render "cancelled"
    // rather than a failure, and `raw/` must be untouched either way.
    await expect(readdir(rawPeriodDir('2026-01'))).rejects.toThrow();
  });

  it('advances progress from the CLI\'s "Copying" lines, which is all it emits', async () => {
    // Verified against gcloud 578 on a real bucket: rsync announces each
    // transfer as it starts and then draws a progress bar — there is no
    // running byte count to scrape. Without deriving progress from those
    // announcements the bar sits at zero for the whole period.
    const progress: SyncProgress[] = [];
    const key = (n: string): string => `focus/billing_period=2026-01/shard-${n}.parquet`;
    mockSpawn.mockImplementationOnce((_bin: unknown, args: unknown) => {
      const proc = new MockChildProcess();
      const dest = (Array.isArray(args) ? args.map(String) : [])[3] ?? '';
      queueMicrotask(() => {
        void writeBqShard(dest, 1).then(() => {
          proc.stderr.emit('data', Buffer.from(
            `At gs://b/focus/billing_period=2026-01/**, worker process 1 thread 2 listed 2...\n`
            + `Copying gs://b/${key('000000000000')} to file:///tmp/a.parquet\n`
            + `Copying gs://b/${key('000000000001')} to file:///tmp/b.parquet\n`
            + `.......\nAverage throughput: 1.0MiB/s\n`));
          proc.emit('close', 0, null);
        });
      });
      return proc;
    });

    await syncGcpSelectedFiles({
      bucketPath: 'gs://b/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file(key('000000000000'), 'h1', 1000), file(key('000000000001'), 'h2', 3000)],
      onProgress: (p) => { progress.push(p); },
    });

    const downloading = progress.filter(p => p.phase === 'downloading');
    // The second "Copying" implies the first file landed: 1 of 2, 1000 bytes.
    expect(downloading.some(p => p.filesDone === 1 && p.bytesDone === 1000)).toBe(true);
    // Never runs backwards, and never past the total.
    const bytes = downloading.map(p => p.bytesDone ?? 0);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(Math.max(...bytes)).toBeLessThanOrEqual(4000);
    const last = progress.at(-1);
    expect(last?.phase).toBe('done');
    expect(last?.bytesDone).toBe(4000);
  });

  it('counts the repartitioning phase in periods, not files', async () => {
    // filesDone was the running FILE count against a periods total, so two
    // shards in one period reported "2 of 1" and the UI fraction ran to 200%.
    const progress: SyncProgress[] = [];
    nextProcess(dest => writeBqShard(dest, 1));
    await syncGcpSelectedFiles({
      bucketPath: 'gs://b/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [
        file('focus/billing_period=2026-01/a.parquet', 'h1'),
        file('focus/billing_period=2026-01/b.parquet', 'h2'),
      ],
      onProgress: (p) => { progress.push(p); },
    });
    for (const p of progress.filter(p => p.phase === 'repartitioning')) {
      expect(p.filesDone).toBeLessThanOrEqual(p.filesTotal);
    }
  });

  it('reports an exact byte total from the listing, before any CLI output', async () => {
    const progress: SyncProgress[] = [];
    nextProcess(dest => writeBqShard(dest, 1));

    await syncGcpSelectedFiles({
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
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
      bucketPath: 'gs://focus-export/focus', providerName, dataDir, expectedDataType: 'daily',
      files: [file('focus/BILLING_PERIOD=2026-01/s.parquet'), file('focus/loose.parquet')],
    });
    expect(result.filesDownloaded).toBe(0);
    expect(mockSpawn).not.toHaveBeenCalled();
  });
});

describe('parseGcloudCopyingKey', () => {
  it('extracts the object key from a real gcloud rsync announcement', () => {
    expect(parseGcloudCopyingKey('Copying gs://my-bucket/focus/billing_period=2026-01/shard-000000000000.parquet to file:///tmp/x.parquet'))
      .toBe('focus/billing_period=2026-01/shard-000000000000.parquet');
  });

  it('ignores the other lines gcloud emits', () => {
    expect(parseGcloudCopyingKey('At gs://b/focus/**, worker process 1 thread 2 listed 2...')).toBeNull();
    expect(parseGcloudCopyingKey('.......')).toBeNull();
    expect(parseGcloudCopyingKey('Average throughput: 1.0MiB/s')).toBeNull();
    expect(parseGcloudCopyingKey('')).toBeNull();
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
