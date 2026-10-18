import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDataInventory, getLocalDataInventory } from '../sync/data-inventory.js';
import { asProviderName } from '../types/branded.js';

/** Two inventory paths the injected-store suites skip: building the
 *  provider's own object store when the caller injects none (here a GCP one,
 *  whose single client factory is faked so no SDK or credential is touched),
 *  and a raw/ entry named like a period directory that is not one. */

interface FakeListing {
  readonly bucket: string;
  readonly prefix: unknown;
}

const { createGcsStorage, listings } = vi.hoisted(() => {
  const listings: FakeListing[] = [];
  return {
    listings,
    createGcsStorage: vi.fn<(options: Record<string, unknown>) => Promise<unknown>>(() => Promise.resolve({
      bucket: (bucket: string) => ({
        getFiles: (query: Record<string, unknown>) => {
          listings.push({ bucket, prefix: query['prefix'] });
          return Promise.resolve([[
            { name: 'focus/daily/billing_period=2026-01/shard-0.parquet', metadata: { crc32c: 'crc-a', size: '700' } },
            { name: 'focus/daily/billing_period=2026-02/shard-0.parquet', metadata: { crc32c: 'crc-b', size: '300' } },
          ]]);
        },
      }),
    })),
  };
});

vi.mock('../sync/gcs-storage.js', () => ({ createGcsStorage }));

const provider = asProviderName('gcp-main');
const READER = 'reader@billing-proj.iam.gserviceaccount.com';

describe('data inventory', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    listings.length = 0;
    dataDir = await mkdtemp(join(tmpdir(), 'inventory-strays-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lists through the provider\'s own store, as its own identity, when no handle is injected', async () => {
    const inventory = await getDataInventory(
      'gs://billing-export/focus/daily/',
      { kind: 'gcp', impersonateServiceAccount: READER },
      dataDir,
      provider,
      'daily',
    );

    expect(createGcsStorage).toHaveBeenCalledTimes(1);
    expect(createGcsStorage).toHaveBeenCalledWith({ impersonateServiceAccount: READER });
    expect(listings).toEqual([{ bucket: 'billing-export', prefix: 'focus/daily/' }]);
    expect(inventory.totalRemoteSize).toBe(1000);
    expect(inventory.periods.map(p => [p.period, p.totalSize, p.localStatus])).toEqual([
      ['2026-02', 300, 'missing'],
      ['2026-01', 700, 'missing'],
    ]);
  });

  it('counts no bytes for a stray file named like a period directory', async () => {
    const rawDir = join(dataDir, String(provider), 'raw');
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await writeFile(join(rawDir, 'daily-2026-01', 'part-0.parquet'), Buffer.alloc(1000, 1));
    // Not a directory: nothing the query layer's raw/daily-*/*.parquet glob reads.
    await writeFile(join(rawDir, 'daily-2026-02'), Buffer.alloc(300, 1));

    const local = await getLocalDataInventory(dataDir, provider, 'daily');

    expect(local.local.diskBytes).toBe(1000);
    expect(local.periods.find(p => p.period === '2026-01')?.totalSize).toBe(1000);
  });
});
