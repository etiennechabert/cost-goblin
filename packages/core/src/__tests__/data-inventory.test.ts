import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDataInventory } from '../sync/data-inventory.js';
import type { S3Handle } from '../sync/s3-client.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import { asProviderName } from '../types/branded.js';

const provider = asProviderName('aws');

function createMockS3Handle(files: ManifestFileEntry[]): S3Handle {
  return {
    listFiles(): Promise<ManifestFileEntry[]> {
      return Promise.resolve(files);
    },
    downloadFile(): Promise<void> {
      return Promise.reject(new Error('downloadFile not implemented in mock'));
    },
  };
}

function file(key: string, hash = 'etag-hash', size = 1000): ManifestFileEntry {
  return { key, contentHash: hash, size };
}

describe('getDataInventory with mocked S3', () => {
  let tempDir: string;
  /** Etag sidecars live in {dataDir}/{provider}/meta/ since #516. */
  let metaDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `costgoblin-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    metaDir = join(tempDir, 'aws', 'meta');
    await mkdir(metaDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('returns empty inventory when S3 has no files', async () => {
    const mock = createMockS3Handle([]);
    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.periods).toEqual([]);
    expect(inventory.totalRemoteSize).toBe(0);
    expect(inventory.totalRemotePeriods).toBe(0);
    expect(inventory.totalLocalPeriods).toBe(0);
    expect(inventory.local.periods).toEqual([]);
    expect(inventory.local.diskBytes).toBe(0);
    expect(inventory.local.oldestPeriod).toBeNull();
    expect(inventory.local.newestPeriod).toBeNull();
  });

  it('lists remote periods with all missing local status', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
      file('cur/data/billing_period=2026-02/file3.parquet', 'hash3', 7000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.totalRemotePeriods).toBe(2);
    expect(inventory.totalRemoteSize).toBe(15000);
    expect(inventory.totalLocalPeriods).toBe(0);

    expect(inventory.periods).toHaveLength(2);
    const periods = inventory.periods.map(p => p.period).sort();
    expect(periods).toEqual(['2026-01', '2026-02']);

    const jan = inventory.periods.find(p => p.period === '2026-01');
    expect(jan?.files).toHaveLength(2);
    expect(jan?.totalSize).toBe(8000);
    expect(jan?.localStatus).toBe('missing');

    const feb = inventory.periods.find(p => p.period === '2026-02');
    expect(feb?.files).toHaveLength(1);
    expect(feb?.totalSize).toBe(7000);
    expect(feb?.localStatus).toBe('missing');
  });

  it('detects repartitioned status when local period exists and hashes match', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
    ]);

    // Create local raw period directory
    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'dummy data');

    // Create etag file with matching hashes
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/billing_period=2026-01/file1.parquet': 'hash1',
        'cur/data/billing_period=2026-01/file2.parquet': 'hash2',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.totalLocalPeriods).toBe(1);
    expect(inventory.local.periods).toEqual(['2026-01']);
    expect(inventory.local.diskBytes).toBeGreaterThan(0);
    expect(inventory.local.oldestPeriod).toBe('2026-01');
    expect(inventory.local.newestPeriod).toBe('2026-01');

    const jan = inventory.periods.find(p => p.period === '2026-01');
    expect(jan?.localStatus).toBe('repartitioned');
  });

  it('detects stale status when local period exists but hash differs', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'new-hash', 5000),
    ]);

    // Create local raw period directory
    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'old data');

    // Create etag file with old hash
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/billing_period=2026-01/file1.parquet': 'old-hash',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    expect(jan?.localStatus).toBe('stale');
  });

  it('handles mixed period statuses correctly', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/billing_period=2026-02/file2.parquet', 'new-hash2', 3000),
      file('cur/data/billing_period=2026-03/file3.parquet', 'hash3', 7000),
    ]);

    // Create local periods for 2026-01 and 2026-02
    const rawDir = join(tempDir, 'aws', 'raw');
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
    await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'data1');
    await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'data2');

    // 2026-01: matching hash (repartitioned)
    // 2026-02: different hash (stale)
    // 2026-03: no local (missing)
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-01': { 'cur/data/billing_period=2026-01/file1.parquet': 'hash1' },
      '2026-02': { 'cur/data/billing_period=2026-02/file2.parquet': 'old-hash2' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.totalRemotePeriods).toBe(3);
    expect(inventory.totalLocalPeriods).toBe(2);

    const jan = inventory.periods.find(p => p.period === '2026-01');
    const feb = inventory.periods.find(p => p.period === '2026-02');
    const mar = inventory.periods.find(p => p.period === '2026-03');

    expect(jan?.localStatus).toBe('repartitioned');
    expect(feb?.localStatus).toBe('stale');
    expect(mar?.localStatus).toBe('missing');
  });

  it('extracts periods from date= format (cost-optimization)', async () => {
    const mock = createMockS3Handle([
      file('cost-opt/date=2026-03-15/file1.parquet', 'hash1', 2000),
      file('cost-opt/date=2026-03-20/file2.parquet', 'hash2', 3000),
      file('cost-opt/date=2026-04-01/file3.parquet', 'hash3', 1000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cost-opt/',
      'default',
      tempDir,
      provider,
      'cost-optimization',
      mock,
    );

    expect(inventory.totalRemotePeriods).toBe(2);
    const periods = inventory.periods.map(p => p.period).sort();
    expect(periods).toEqual(['2026-03', '2026-04']);

    const mar = inventory.periods.find(p => p.period === '2026-03');
    expect(mar?.files).toHaveLength(2);
    expect(mar?.totalSize).toBe(5000);
  });

  it('sorts periods in descending order (newest first)', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 1000),
      file('cur/data/billing_period=2026-03/file2.parquet', 'hash2', 1000),
      file('cur/data/billing_period=2026-02/file3.parquet', 'hash3', 1000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    const periods = inventory.periods.map(p => p.period);
    expect(periods).toEqual(['2026-03', '2026-02', '2026-01']);
  });

  it('handles hourly tier with correct etag file', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'hourly-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'hourly data');

    const etagFile = join(metaDir, 'sync-etags-hourly.json');
    const etags = {
      '2026-01': { 'cur/data/billing_period=2026-01/file1.parquet': 'hash1' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'hourly',
      mock,
    );

    expect(inventory.totalLocalPeriods).toBe(1);
    const jan = inventory.periods.find(p => p.period === '2026-01');
    expect(jan?.localStatus).toBe('repartitioned');
  });

  it('handles cost-optimization tier with correct etag file and directory prefix', async () => {
    const mock = createMockS3Handle([
      file('cost-opt/date=2026-03-15/file1.parquet', 'hash1', 5000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'cost-opt-2026-03');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'cost-opt data');

    const etagFile = join(metaDir, 'sync-etags-cost-optimization.json');
    const etags = {
      '2026-03': { 'cost-opt/date=2026-03-15/file1.parquet': 'hash1' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cost-opt/',
      'default',
      tempDir,
      provider,
      'cost-optimization',
      mock,
    );

    expect(inventory.totalLocalPeriods).toBe(1);
    expect(inventory.local.periods).toEqual(['2026-03']);
    const mar = inventory.periods.find(p => p.period === '2026-03');
    expect(mar?.localStatus).toBe('repartitioned');
  });

  it('treats period as stale when etag file is missing', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // No etag file created

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.totalLocalPeriods).toBe(1);
    const jan = inventory.periods.find(p => p.period === '2026-01');
    // Without an etag file we can't prove the local data matches remote, so
    // the period is reported as stale and the user can re-sync to verify.
    expect(jan?.localStatus).toBe('stale');
  });

  it('detects stale when etag file exists but has no entry for period', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // Create etag file but without entry for 2026-01
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-02': { 'cur/data/billing_period=2026-02/file1.parquet': 'hash2' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // Etag file exists but has no entry for this period → unverified → stale.
    // This is the field-observed bug: 5 local files, no etag record, reported
    // as fresh while charts showed gaps.
    expect(jan?.localStatus).toBe('stale');
  });

  it('detects stale when etag file is missing entries for some remote files', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
      file('cur/data/billing_period=2026-01/file3.parquet', 'hash3', 2000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // Etag file only has entries for file1 and file2, not file3
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/billing_period=2026-01/file1.parquet': 'hash1',
        'cur/data/billing_period=2026-01/file2.parquet': 'hash2',
        // file3 not in etags — appeared on remote since the last sync
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // file3 has no saved etag — we can't prove we have it locally, so the
    // period is stale and a re-sync will pick file3 up.
    expect(jan?.localStatus).toBe('stale');
  });

  it('detects stale when one file hash differs among multiple files', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'new-hash1', 5000),
      file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
      file('cur/data/billing_period=2026-01/file3.parquet', 'hash3', 2000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // file1 has changed hash, file2 and file3 match
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/billing_period=2026-01/file1.parquet': 'old-hash1',
        'cur/data/billing_period=2026-01/file2.parquet': 'hash2',
        'cur/data/billing_period=2026-01/file3.parquet': 'hash3',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // One file has different hash → stale
    expect(jan?.localStatus).toBe('stale');
  });

  it('detects stale when only one file is tracked and it differs', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'new-hash', 5000),
      file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // Only file1 is in etags and it differs, file2 is not tracked
    const etagFile = join(metaDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/billing_period=2026-01/file1.parquet': 'old-hash',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // The one tracked file differs → stale
    expect(jan?.localStatus).toBe('stale');
  });

  it('handles local period without corresponding remote files', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-02/file1.parquet', 'hash1', 5000),
    ]);

    // Create local period for 2026-01 that doesn't exist remotely
    const rawDir = join(tempDir, 'aws', 'raw');
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
    await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'old data');
    await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'current data');

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    // totalLocalPeriods includes both 2026-01 and 2026-02
    expect(inventory.totalLocalPeriods).toBe(2);
    expect(inventory.local.periods).toEqual(['2026-01', '2026-02']);

    // But inventory.periods only includes remote periods (2026-02)
    expect(inventory.totalRemotePeriods).toBe(1);
    expect(inventory.periods).toHaveLength(1);
    expect(inventory.periods[0]?.period).toBe('2026-02');
  });

  it('skips files without recognizable period markers', async () => {
    const mock = createMockS3Handle([
      file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/random-path/file2.parquet', 'hash2', 3000),
      file('cur/metadata.parquet', 'hash3', 1000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    // Only the file with BILLING_PERIOD should be included in periods
    expect(inventory.totalRemotePeriods).toBe(1);
    expect(inventory.periods).toHaveLength(1);
    expect(inventory.periods[0]?.period).toBe('2026-01');
    // totalRemoteSize includes all files, even those without recognized periods
    expect(inventory.totalRemoteSize).toBe(9000);
  });

  it('calculates local disk bytes correctly across multiple periods', async () => {
    const mock = createMockS3Handle([]);

    const rawDir = join(tempDir, 'aws', 'raw');
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });

    // Write files with known sizes
    await writeFile(join(rawDir, 'daily-2026-01', 'file1.parquet'), 'a'.repeat(1000));
    await writeFile(join(rawDir, 'daily-2026-01', 'file2.parquet'), 'b'.repeat(2000));
    await writeFile(join(rawDir, 'daily-2026-02', 'file3.parquet'), 'c'.repeat(3000));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.local.diskBytes).toBe(6000);
  });

  it('handles nested directory structures when calculating disk bytes', async () => {
    const mock = createMockS3Handle([]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    const subDir = join(periodDir, 'subfolder');
    await mkdir(subDir, { recursive: true });

    await writeFile(join(periodDir, 'file1.parquet'), 'a'.repeat(1000));
    await writeFile(join(subDir, 'file2.parquet'), 'b'.repeat(2000));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.local.diskBytes).toBe(3000);
  });

  it('sets oldest and newest period correctly', async () => {
    const mock = createMockS3Handle([]);

    const rawDir = join(tempDir, 'aws', 'raw');
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
    await mkdir(join(rawDir, 'daily-2026-03'), { recursive: true });
    await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'data');
    await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'data');
    await writeFile(join(rawDir, 'daily-2026-03', 'data.parquet'), 'data');

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      provider,
      'daily',
      mock,
    );

    expect(inventory.local.oldestPeriod).toBe('2026-01');
    expect(inventory.local.newestPeriod).toBe('2026-03');
  });

  it('handles tier-specific directory prefixes correctly', async () => {
    const mock = createMockS3Handle([]);

    const rawDir = join(tempDir, 'aws', 'raw');

    // Create directories for different tiers to ensure we only count the right ones
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await mkdir(join(rawDir, 'hourly-2026-01'), { recursive: true });
    await mkdir(join(rawDir, 'cost-opt-2026-01'), { recursive: true });

    await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'daily');
    await writeFile(join(rawDir, 'hourly-2026-01', 'data.parquet'), 'hourly');
    await writeFile(join(rawDir, 'cost-opt-2026-01', 'data.parquet'), 'cost-opt');

    const expected = [
      { tier: 'daily' as const, periods: ['2026-01'], bytes: 5 },
      { tier: 'hourly' as const, periods: ['2026-01'], bytes: 6 },
      { tier: 'cost-optimization' as const, periods: ['2026-01'], bytes: 8 },
    ];

    for (const { tier, periods, bytes } of expected) {
      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        tier,
        mock,
      );

      expect(inventory.local.periods).toEqual(periods);
      expect(inventory.local.diskBytes).toBe(bytes);
    }
  });

  describe('incremental sync validation', () => {
    it('marks period as repartitioned when all tracked files have matching etags (skip sync)', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'etag-abc', 5000),
        file('cur/data/billing_period=2026-01/file2.parquet', 'etag-def', 3000),
        file('cur/data/billing_period=2026-01/file3.parquet', 'etag-ghi', 2000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'local data');

      // All three files have matching etags
      const etagFile = join(metaDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/billing_period=2026-01/file1.parquet': 'etag-abc',
          'cur/data/billing_period=2026-01/file2.parquet': 'etag-def',
          'cur/data/billing_period=2026-01/file3.parquet': 'etag-ghi',
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // All etags match → repartitioned → sync can safely skip this period
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('marks period as stale when any tracked file has mismatched etag (must re-sync entire period)', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'etag-abc', 5000),
        file('cur/data/billing_period=2026-01/file2.parquet', 'etag-xyz-NEW', 3000),
        file('cur/data/billing_period=2026-01/file3.parquet', 'etag-ghi', 2000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'local data');

      // file2 has changed etag (was etag-def, now etag-xyz-NEW)
      const etagFile = join(metaDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/billing_period=2026-01/file1.parquet': 'etag-abc',
          'cur/data/billing_period=2026-01/file2.parquet': 'etag-def',
          'cur/data/billing_period=2026-01/file3.parquet': 'etag-ghi',
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // One etag differs → stale → entire period must be re-synced
      expect(jan?.localStatus).toBe('stale');
    });

    it('marks period as stale when remote has new files not yet in etag cache', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'etag-abc', 5000),
        file('cur/data/billing_period=2026-01/file2.parquet', 'etag-def', 3000),
        file('cur/data/billing_period=2026-01/file3-NEW.parquet', 'etag-new', 1000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'local data');

      // Etag cache only has file1 and file2, file3-NEW is a new remote file
      const etagFile = join(metaDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/billing_period=2026-01/file1.parquet': 'etag-abc',
          'cur/data/billing_period=2026-01/file2.parquet': 'etag-def',
          // file3-NEW not in cache
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // file3-NEW has no saved etag → we have not downloaded it → stale.
      // The user re-syncs and aws s3 sync only transfers file3-NEW.
      expect(jan?.localStatus).toBe('stale');
    });

    it('validates etag-based skip decision across all three status values', async () => {
      const mock = createMockS3Handle([
        // Period 1: repartitioned (skip)
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 1000),
        // Period 2: stale (re-download)
        file('cur/data/billing_period=2026-02/file2.parquet', 'new-hash2', 2000),
        // Period 3: missing (download)
        file('cur/data/billing_period=2026-03/file3.parquet', 'hash3', 3000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
      await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
      await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'data1');
      await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'data2');

      const etagFile = join(metaDir, 'sync-etags.json');
      const etags = {
        '2026-01': { 'cur/data/billing_period=2026-01/file1.parquet': 'hash1' },
        '2026-02': { 'cur/data/billing_period=2026-02/file2.parquet': 'old-hash2' },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const initial: Record<string, string> = {};
      const periods = inventory.periods.reduce((acc, p) => {
        acc[p.period] = p.localStatus;
        return acc;
      }, initial);

      // Incremental sync decision matrix:
      expect(periods['2026-01']).toBe('repartitioned'); // SKIP: local matches remote
      expect(periods['2026-02']).toBe('stale');         // RE-DOWNLOAD: local outdated
      expect(periods['2026-03']).toBe('missing');       // DOWNLOAD: not synced yet
    });

    it('reproduces issue #278: hourly period with files local but no etag entry → stale', async () => {
      // Field-observed: 53 files on remote, 5 files in local raw dir,
      // 0 entries for the period in sync-etags-hourly.json. The UI badge
      // showed "Downloaded" instead of "stale" — chart silently empty.
      const remoteFiles = Array.from({ length: 53 }, (_, i) =>
        file(`hourly/billing_period=2026-04/data-${String(i).padStart(5, '0')}.parquet`, `etag-${String(i)}`, 1000),
      );
      const mock = createMockS3Handle(remoteFiles);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'hourly-2026-04');
      await mkdir(periodDir, { recursive: true });
      // 5 of 53 files on disk
      for (let i = 0; i < 5; i++) {
        await writeFile(join(periodDir, `data-${String(i).padStart(5, '0')}.parquet`), 'partial');
      }

      // Etag file exists for some other period entirely — 2026-04 is absent.
      const etagFile = join(metaDir, 'sync-etags-hourly.json');
      await writeFile(etagFile, JSON.stringify({
        '2026-03': { 'hourly/billing_period=2026-03/data-00000.parquet': 'etag-march' },
      }));

      const inventory = await getDataInventory(
        's3://test-bucket/hourly/',
        'default',
        tempDir,
        provider,
        'hourly',
        mock,
      );

      const apr = inventory.periods.find(p => p.period === '2026-04');
      expect(apr?.localStatus).toBe('stale');
    });

    it('marks period as stale when etag file is empty', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Etag file exists but is empty (first sync after etag feature deployed,
      // or local data carried over from an older sync version that didn't
      // write etags).
      const etagFile = join(metaDir, 'sync-etags.json');
      await writeFile(etagFile, JSON.stringify({}));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // No etag tracking → unverified → stale. The user can re-sync and the
      // resulting etag file will mark the period repartitioned thereafter.
      expect(jan?.localStatus).toBe('stale');
    });
  });

  describe('corrupted manifest JSON handling', () => {
    it('handles invalid JSON syntax gracefully', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Write invalid JSON to etag file
      const etagFile = join(metaDir, 'sync-etags.json');
      await writeFile(etagFile, 'not valid json {{{');

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      // Should not throw — corrupted etag JSON parses to empty record, then
      // the period is reported stale because no file has a verified etag.
      expect(inventory.totalLocalPeriods).toBe(1);
      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('stale');
    });

    it('handles JSON array instead of object', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Write JSON array instead of object
      const etagFile = join(metaDir, 'sync-etags.json');
      await writeFile(etagFile, JSON.stringify(['not', 'an', 'object']));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      // Should treat as empty etag cache → no verified etags → stale.
      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('stale');
    });

    it('handles JSON null instead of object', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      const etagFile = join(metaDir, 'sync-etags.json');
      await writeFile(etagFile, 'null');

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('stale');
    });

    it('handles JSON string instead of object', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      const etagFile = join(metaDir, 'sync-etags.json');
      await writeFile(etagFile, JSON.stringify('string value'));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('stale');
    });

    it('skips period entries that are not objects', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'new-hash1', 5000),
        file('cur/data/billing_period=2026-02/file2.parquet', 'new-hash2', 3000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
      await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
      await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'data1');
      await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'data2');

      // 2026-01 is a string instead of object, 2026-02 is valid
      const etagFile = join(metaDir, 'sync-etags.json');
      const corruptedEtags = {
        '2026-01': 'not-an-object',
        '2026-02': { 'cur/data/billing_period=2026-02/file2.parquet': 'new-hash2' },
      };
      await writeFile(etagFile, JSON.stringify(corruptedEtags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      const feb = inventory.periods.find(p => p.period === '2026-02');

      // 2026-01: corrupted period entry is dropped from the parsed record →
      // file1 has no verified etag → stale.
      expect(jan?.localStatus).toBe('stale');
      // 2026-02: valid entry with matching hash → repartitioned
      expect(feb?.localStatus).toBe('repartitioned');
    });

    it('drops non-string hash values within a period', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'hash1', 5000),
        file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
        file('cur/data/billing_period=2026-01/file3.parquet', 'hash3', 2000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Mix of valid and invalid hash types
      const etagFile = join(metaDir, 'sync-etags.json');
      const corruptedEtags = {
        '2026-01': {
          'cur/data/billing_period=2026-01/file1.parquet': 'hash1',
          'cur/data/billing_period=2026-01/file2.parquet': 42, // number
          'cur/data/billing_period=2026-01/file3.parquet': null, // null
        },
      };
      await writeFile(etagFile, JSON.stringify(corruptedEtags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // file1 has a valid matching etag, but file2 and file3 had non-string
      // values that the parser dropped → those files are unverified → stale.
      expect(jan?.localStatus).toBe('stale');
    });

    it('detects stale when valid hash differs despite other corrupted entries', async () => {
      const mock = createMockS3Handle([
        file('cur/data/billing_period=2026-01/file1.parquet', 'new-hash1', 5000),
        file('cur/data/billing_period=2026-01/file2.parquet', 'hash2', 3000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // file1 has valid but stale hash, file2 has corrupted hash value
      const etagFile = join(metaDir, 'sync-etags.json');
      const corruptedEtags = {
        '2026-01': {
          'cur/data/billing_period=2026-01/file1.parquet': 'old-hash1',
          'cur/data/billing_period=2026-01/file2.parquet': false, // boolean
        },
      };
      await writeFile(etagFile, JSON.stringify(corruptedEtags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        provider,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // file1's valid etag differs → stale (file2's invalid etag is ignored)
      expect(jan?.localStatus).toBe('stale');
    });
  });
});
