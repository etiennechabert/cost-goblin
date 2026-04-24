import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDataInventory } from '../sync/data-inventory.js';
import type { S3Handle } from '../sync/s3-client.js';
import type { ManifestFileEntry } from '../sync/manifest.js';

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

  beforeEach(async () => {
    tempDir = join(tmpdir(), `costgoblin-test-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
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
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
      file('cur/data/BILLING_PERIOD=2026-02/file3.parquet', 'hash3', 7000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
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
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
    ]);

    // Create local raw period directory
    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'dummy data');

    // Create etag file with matching hashes
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1',
        'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'hash2',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
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
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'new-hash', 5000),
    ]);

    // Create local raw period directory
    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'old data');

    // Create etag file with old hash
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'old-hash',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    expect(jan?.localStatus).toBe('stale');
  });

  it('handles mixed period statuses correctly', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/BILLING_PERIOD=2026-02/file2.parquet', 'new-hash2', 3000),
      file('cur/data/BILLING_PERIOD=2026-03/file3.parquet', 'hash3', 7000),
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
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-01': { 'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1' },
      '2026-02': { 'cur/data/BILLING_PERIOD=2026-02/file2.parquet': 'old-hash2' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
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
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 1000),
      file('cur/data/BILLING_PERIOD=2026-03/file2.parquet', 'hash2', 1000),
      file('cur/data/BILLING_PERIOD=2026-02/file3.parquet', 'hash3', 1000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      'daily',
      mock,
    );

    const periods = inventory.periods.map(p => p.period);
    expect(periods).toEqual(['2026-03', '2026-02', '2026-01']);
  });

  it('handles hourly tier with correct etag file', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'hourly-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'hourly data');

    const etagFile = join(tempDir, 'sync-etags-hourly.json');
    const etags = {
      '2026-01': { 'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
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

    const etagFile = join(tempDir, 'sync-etags-cost-optimization.json');
    const etags = {
      '2026-03': { 'cost-opt/date=2026-03-15/file1.parquet': 'hash1' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cost-opt/',
      'default',
      tempDir,
      'cost-optimization',
      mock,
    );

    expect(inventory.totalLocalPeriods).toBe(1);
    expect(inventory.local.periods).toEqual(['2026-03']);
    const mar = inventory.periods.find(p => p.period === '2026-03');
    expect(mar?.localStatus).toBe('repartitioned');
  });

  it('handles missing etag file gracefully', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
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
      'daily',
      mock,
    );

    expect(inventory.totalLocalPeriods).toBe(1);
    const jan = inventory.periods.find(p => p.period === '2026-01');
    // Without etag file, we can't verify staleness, so it's considered repartitioned
    expect(jan?.localStatus).toBe('repartitioned');
  });

  it('detects repartitioned when etag file exists but has no entry for period', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // Create etag file but without entry for 2026-01
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-02': { 'cur/data/BILLING_PERIOD=2026-02/file1.parquet': 'hash2' },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // Etag file exists but has no entry for this period → repartitioned
    expect(jan?.localStatus).toBe('repartitioned');
  });

  it('detects repartitioned when etag file has partial file coverage with all matching', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
      file('cur/data/BILLING_PERIOD=2026-01/file3.parquet', 'hash3', 2000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // Etag file only has entries for file1 and file2, not file3
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1',
        'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'hash2',
        // file3 not in etags
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // All files that have etags match, missing etags are ignored → repartitioned
    expect(jan?.localStatus).toBe('repartitioned');
  });

  it('detects stale when one file hash differs among multiple files', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'new-hash1', 5000),
      file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
      file('cur/data/BILLING_PERIOD=2026-01/file3.parquet', 'hash3', 2000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // file1 has changed hash, file2 and file3 match
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'old-hash1',
        'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'hash2',
        'cur/data/BILLING_PERIOD=2026-01/file3.parquet': 'hash3',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // One file has different hash → stale
    expect(jan?.localStatus).toBe('stale');
  });

  it('detects stale when only one file is tracked and it differs', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'new-hash', 5000),
      file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
    ]);

    const rawDir = join(tempDir, 'aws', 'raw');
    const periodDir = join(rawDir, 'daily-2026-01');
    await mkdir(periodDir, { recursive: true });
    await writeFile(join(periodDir, 'data.parquet'), 'data');

    // Only file1 is in etags and it differs, file2 is not tracked
    const etagFile = join(tempDir, 'sync-etags.json');
    const etags = {
      '2026-01': {
        'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'old-hash',
      },
    };
    await writeFile(etagFile, JSON.stringify(etags));

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
      'daily',
      mock,
    );

    const jan = inventory.periods.find(p => p.period === '2026-01');
    // The one tracked file differs → stale
    expect(jan?.localStatus).toBe('stale');
  });

  it('handles local period without corresponding remote files', async () => {
    const mock = createMockS3Handle([
      file('cur/data/BILLING_PERIOD=2026-02/file1.parquet', 'hash1', 5000),
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
      file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      file('cur/data/random-path/file2.parquet', 'hash2', 3000),
      file('cur/metadata.parquet', 'hash3', 1000),
    ]);

    const inventory = await getDataInventory(
      's3://test-bucket/cur/',
      'default',
      tempDir,
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
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'etag-abc', 5000),
        file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'etag-def', 3000),
        file('cur/data/BILLING_PERIOD=2026-01/file3.parquet', 'etag-ghi', 2000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'local data');

      // All three files have matching etags
      const etagFile = join(tempDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'etag-abc',
          'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'etag-def',
          'cur/data/BILLING_PERIOD=2026-01/file3.parquet': 'etag-ghi',
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // All etags match → repartitioned → sync can safely skip this period
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('marks period as stale when any tracked file has mismatched etag (must re-sync entire period)', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'etag-abc', 5000),
        file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'etag-xyz-NEW', 3000),
        file('cur/data/BILLING_PERIOD=2026-01/file3.parquet', 'etag-ghi', 2000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'local data');

      // file2 has changed etag (was etag-def, now etag-xyz-NEW)
      const etagFile = join(tempDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'etag-abc',
          'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'etag-def',
          'cur/data/BILLING_PERIOD=2026-01/file3.parquet': 'etag-ghi',
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // One etag differs → stale → entire period must be re-synced
      expect(jan?.localStatus).toBe('stale');
    });

    it('allows incremental sync: new remote files not in etag cache do not trigger stale status', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'etag-abc', 5000),
        file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'etag-def', 3000),
        file('cur/data/BILLING_PERIOD=2026-01/file3-NEW.parquet', 'etag-new', 1000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'local data');

      // Etag cache only has file1 and file2, file3-NEW is a new remote file
      const etagFile = join(tempDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'etag-abc',
          'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'etag-def',
          // file3-NEW not in cache
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // Tracked files (file1, file2) match → repartitioned
      // New file (file3-NEW) is not tracked, so doesn't cause stale status
      // Sync orchestrator will download new file incrementally
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('validates multi-period incremental sync: unchanged period stays repartitioned', async () => {
      const mock = createMockS3Handle([
        // Period 2026-01: unchanged (etags match)
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
        file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
        // Period 2026-02: missing locally
        file('cur/data/BILLING_PERIOD=2026-02/file3.parquet', 'hash3', 7000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const jan2026Dir = join(rawDir, 'daily-2026-01');
      await mkdir(jan2026Dir, { recursive: true });
      await writeFile(join(jan2026Dir, 'data.parquet'), 'jan data');

      // Etag cache shows 2026-01 was previously synced with matching hashes
      const etagFile = join(tempDir, 'sync-etags.json');
      const etags = {
        '2026-01': {
          'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1',
          'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 'hash2',
        },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      const feb = inventory.periods.find(p => p.period === '2026-02');

      // 2026-01: unchanged → repartitioned → skip
      expect(jan?.localStatus).toBe('repartitioned');
      // 2026-02: new period → missing → download
      expect(feb?.localStatus).toBe('missing');

      // Incremental sync would skip 2026-01 and only download 2026-02
      expect(inventory.totalRemotePeriods).toBe(2);
      expect(inventory.totalLocalPeriods).toBe(1);
    });

    it('validates etag-based skip decision across all three status values', async () => {
      const mock = createMockS3Handle([
        // Period 1: repartitioned (skip)
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 1000),
        // Period 2: stale (re-download)
        file('cur/data/BILLING_PERIOD=2026-02/file2.parquet', 'new-hash2', 2000),
        // Period 3: missing (download)
        file('cur/data/BILLING_PERIOD=2026-03/file3.parquet', 'hash3', 3000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
      await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
      await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'data1');
      await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'data2');

      const etagFile = join(tempDir, 'sync-etags.json');
      const etags = {
        '2026-01': { 'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1' },
        '2026-02': { 'cur/data/BILLING_PERIOD=2026-02/file2.parquet': 'old-hash2' },
      };
      await writeFile(etagFile, JSON.stringify(etags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
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

    it('validates empty etag cache does not prevent initial sync', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Etag file exists but is empty (first sync after etag feature deployed)
      const etagFile = join(tempDir, 'sync-etags.json');
      await writeFile(etagFile, JSON.stringify({}));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // No etag tracking for this period → assume repartitioned
      // (conservative: treat as synced, sync orchestrator can handle validation)
      expect(jan?.localStatus).toBe('repartitioned');
    });
  });

  describe('corrupted manifest JSON handling', () => {
    it('handles invalid JSON syntax gracefully', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Write invalid JSON to etag file
      const etagFile = join(tempDir, 'sync-etags.json');
      await writeFile(etagFile, 'not valid json {{{');

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      // Should not throw, should treat as if no etag file exists
      expect(inventory.totalLocalPeriods).toBe(1);
      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('handles JSON array instead of object', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Write JSON array instead of object
      const etagFile = join(tempDir, 'sync-etags.json');
      await writeFile(etagFile, JSON.stringify(['not', 'an', 'object']));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      // Should treat as empty etag cache
      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('handles JSON null instead of object', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      const etagFile = join(tempDir, 'sync-etags.json');
      await writeFile(etagFile, 'null');

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('handles JSON string instead of object', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      const etagFile = join(tempDir, 'sync-etags.json');
      await writeFile(etagFile, JSON.stringify('string value'));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('skips period entries that are not objects', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'new-hash1', 5000),
        file('cur/data/BILLING_PERIOD=2026-02/file2.parquet', 'new-hash2', 3000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
      await mkdir(join(rawDir, 'daily-2026-02'), { recursive: true });
      await writeFile(join(rawDir, 'daily-2026-01', 'data.parquet'), 'data1');
      await writeFile(join(rawDir, 'daily-2026-02', 'data.parquet'), 'data2');

      // 2026-01 is a string instead of object, 2026-02 is valid
      const etagFile = join(tempDir, 'sync-etags.json');
      const corruptedEtags = {
        '2026-01': 'not-an-object',
        '2026-02': { 'cur/data/BILLING_PERIOD=2026-02/file2.parquet': 'new-hash2' },
      };
      await writeFile(etagFile, JSON.stringify(corruptedEtags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      const feb = inventory.periods.find(p => p.period === '2026-02');

      // 2026-01: corrupted period entry is skipped → treated as repartitioned
      expect(jan?.localStatus).toBe('repartitioned');
      // 2026-02: valid entry with matching hash → repartitioned
      expect(feb?.localStatus).toBe('repartitioned');
    });

    it('drops non-string hash values within a period', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'hash1', 5000),
        file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
        file('cur/data/BILLING_PERIOD=2026-01/file3.parquet', 'hash3', 2000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // Mix of valid and invalid hash types
      const etagFile = join(tempDir, 'sync-etags.json');
      const corruptedEtags = {
        '2026-01': {
          'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'hash1',
          'cur/data/BILLING_PERIOD=2026-01/file2.parquet': 42, // number
          'cur/data/BILLING_PERIOD=2026-01/file3.parquet': null, // null
        },
      };
      await writeFile(etagFile, JSON.stringify(corruptedEtags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // Only file1 has valid etag and it matches → repartitioned
      // file2 and file3 have invalid etags (dropped) → not compared
      expect(jan?.localStatus).toBe('repartitioned');
    });

    it('detects stale when valid hash differs despite other corrupted entries', async () => {
      const mock = createMockS3Handle([
        file('cur/data/BILLING_PERIOD=2026-01/file1.parquet', 'new-hash1', 5000),
        file('cur/data/BILLING_PERIOD=2026-01/file2.parquet', 'hash2', 3000),
      ]);

      const rawDir = join(tempDir, 'aws', 'raw');
      const periodDir = join(rawDir, 'daily-2026-01');
      await mkdir(periodDir, { recursive: true });
      await writeFile(join(periodDir, 'data.parquet'), 'data');

      // file1 has valid but stale hash, file2 has corrupted hash value
      const etagFile = join(tempDir, 'sync-etags.json');
      const corruptedEtags = {
        '2026-01': {
          'cur/data/BILLING_PERIOD=2026-01/file1.parquet': 'old-hash1',
          'cur/data/BILLING_PERIOD=2026-01/file2.parquet': false, // boolean
        },
      };
      await writeFile(etagFile, JSON.stringify(corruptedEtags));

      const inventory = await getDataInventory(
        's3://test-bucket/cur/',
        'default',
        tempDir,
        'daily',
        mock,
      );

      const jan = inventory.periods.find(p => p.period === '2026-01');
      // file1's valid etag differs → stale (file2's invalid etag is ignored)
      expect(jan?.localStatus).toBe('stale');
    });
  });
});
