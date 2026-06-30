import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getLocalDataInventory, hasSyncedTier } from '../sync/data-inventory.js';
import { writeTierLastSync } from '../sync/sync-timestamps.js';

describe('getLocalDataInventory (disk-only fallback)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `costgoblin-local-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  async function writeRawFile(tier: string, period: string, name: string, bytes: number): Promise<void> {
    const dir = join(tempDir, 'aws', 'raw', `${tier}-${period}`);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), Buffer.alloc(bytes, 1));
  }

  it('computes per-period sizes from disk instead of zero (issue: months showed 0B)', async () => {
    await writeRawFile('daily', '2026-05', 'a.parquet', 1000);
    await writeRawFile('daily', '2026-05', 'b.parquet', 500);
    await writeRawFile('daily', '2026-06', 'c.parquet', 2000);

    const inv = await getLocalDataInventory(tempDir, 'daily');

    expect(inv.totalLocalPeriods).toBe(2);
    expect(inv.local.diskBytes).toBe(3500);

    const may = inv.periods.find(p => p.period === '2026-05');
    const jun = inv.periods.find(p => p.period === '2026-06');
    expect(may?.totalSize).toBe(1500);
    expect(jun?.totalSize).toBe(2000);
    expect(may?.localStatus).toBe('repartitioned');

    // newest-first ordering, mirroring the S3-backed inventory
    expect(inv.periods.map(p => p.period)).toEqual(['2026-06', '2026-05']);
    expect(inv.local.oldestPeriod).toBe('2026-05');
    expect(inv.local.newestPeriod).toBe('2026-06');
  });

  it('returns an empty inventory when no raw data exists', async () => {
    const inv = await getLocalDataInventory(tempDir, 'daily');
    expect(inv.periods).toEqual([]);
    expect(inv.totalLocalPeriods).toBe(0);
    expect(inv.local.diskBytes).toBe(0);
    expect(inv.lastSync).toBeNull();
  });

  it('surfaces the persisted lastSync timestamp', async () => {
    await writeRawFile('daily', '2026-06', 'c.parquet', 10);
    await writeTierLastSync(tempDir, 'daily', '2026-06-26T10:00:00.000Z');
    const inv = await getLocalDataInventory(tempDir, 'daily');
    expect(inv.lastSync).toBe('2026-06-26T10:00:00.000Z');
  });

  it('isolates tiers — hourly raw is not counted under daily', async () => {
    await writeRawFile('daily', '2026-06', 'd.parquet', 100);
    await writeRawFile('hourly', '2026-06', 'h.parquet', 999);

    const daily = await getLocalDataInventory(tempDir, 'daily');
    expect(daily.local.diskBytes).toBe(100);
    expect(daily.periods.find(p => p.period === '2026-06')?.totalSize).toBe(100);

    const hourly = await getLocalDataInventory(tempDir, 'hourly');
    expect(hourly.local.diskBytes).toBe(999);
    expect(hourly.periods.find(p => p.period === '2026-06')?.totalSize).toBe(999);
  });
});

describe('hasSyncedTier', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `costgoblin-synced-${String(Date.now())}-${Math.random().toString(36).slice(2)}`);
    await mkdir(tempDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it('is false when no etag file exists (e.g. imported snapshot)', async () => {
    expect(await hasSyncedTier(tempDir, 'daily')).toBe(false);
  });

  it('is true once the tier etag file exists, per tier', async () => {
    await writeFile(join(tempDir, 'sync-etags.json'), '{}');
    expect(await hasSyncedTier(tempDir, 'daily')).toBe(true);
    // hourly uses its own etag file → still not synced
    expect(await hasSyncedTier(tempDir, 'hourly')).toBe(false);

    await writeFile(join(tempDir, 'sync-etags-hourly.json'), '{}');
    expect(await hasSyncedTier(tempDir, 'hourly')).toBe(true);
  });
});
