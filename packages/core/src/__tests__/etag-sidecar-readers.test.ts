import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataInventory, hasSyncedTier } from '../sync/data-inventory.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import type { ObjectStoreHandle, ProviderAuth } from '../sync/object-store.js';
import { providerEtagPath, providerMetaDir, providerRawDir } from '../sync/provider-paths.js';
import { readEtags } from '../sync/sync-utils.js';
import { asProviderName } from '../types/branded.js';

// The readers' counterpart of etag-sidecar.test.ts: a real tmp dir behind
// pass-through fs wrappers, so a test can fail one precise read or stat.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    stat: vi.fn(actual.stat),
  };
});
// Retry backoff resolves at once; tests assert the delays it asked for.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(() => Promise.resolve()) }));
vi.mock('../logger/logger.js');

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

type Sidecar = Record<string, Record<string, string>>;

const provider = asProviderName('aws');
const AWS_AUTH: ProviderAuth = { kind: 'aws-profile', profile: 'default' };
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });
const sleptMs = (): unknown[] => vi.mocked(sleep).mock.calls.map(([ms]) => ms);
const ALL_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

function storeListing(files: readonly ManifestFileEntry[]): ObjectStoreHandle {
  return {
    listFiles: () => Promise.resolve([...files]),
    downloadFile: () => Promise.reject(new Error('downloadFile not used by the inventory')),
  };
}

describe('etag sidecar reads', () => {
  let dataDir: string;

  const etagPath = (tier = 'daily'): string => providerEtagPath(dataDir, provider, tier);

  async function seedSidecar(content: Sidecar): Promise<void> {
    await fsActual.mkdir(providerMetaDir(dataDir, provider), { recursive: true });
    await fsActual.writeFile(etagPath(), JSON.stringify(content, null, 2));
  }

  /** Fails the next `times` reads of the daily sidecar (all of them by
   *  default) with `code`; every other read — sync timestamps — passes through. */
  function failSidecarReads(code: string, times = Number.POSITIVE_INFINITY): void {
    let left = times;
    vi.mocked(readFile).mockImplementation(async (file, options) => {
      if (file === etagPath() && left > 0) {
        left -= 1;
        throw errno(code);
      }
      return fsActual.readFile(file, options);
    });
  }

  /** The same for stats of the daily sidecar. */
  function failSidecarStats(code: string, times = Number.POSITIVE_INFINITY): void {
    let left = times;
    vi.mocked(stat).mockImplementation(async (file, options) => {
      if (file === etagPath() && left > 0) {
        left -= 1;
        throw errno(code);
      }
      return fsActual.stat(file, options);
    });
  }

  const sidecarReads = (): number => vi.mocked(readFile).mock.calls.filter(([file]) => file === etagPath()).length;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'costgoblin-etag-reads-'));
  });

  afterEach(async () => {
    // Restores the pass-through implementations so one test's injection can
    // never leak into the next.
    for (const fn of [readFile, stat]) vi.mocked(fn).mockReset();
    vi.mocked(sleep).mockClear();
    await fsActual.rm(dataDir, { recursive: true, force: true });
  });

  describe('readEtags', () => {
    it('is empty for a tier that has no sidecar yet', async () => {
      expect(await readEtags(dataDir, provider, 'daily')).toEqual({});
      expect(sleptMs()).toEqual([]);
    });

    it('returns what saveEtags recorded', async () => {
      const seed: Sidecar = { '2026-01': { 'k/a.parquet': 'h-a' }, '2026-02': { 'k/b.parquet': 'h-b' } };
      await seedSidecar(seed);

      expect(await readEtags(dataDir, provider, 'daily')).toEqual(seed);
    });

    it.each(['EMFILE', 'EBUSY', 'EPERM', 'EACCES'])('retries a transient %s read', async (code) => {
      const seed: Sidecar = { '2026-01': { 'k/a.parquet': 'h-a' } };
      await seedSidecar(seed);
      failSidecarReads(code, 1);

      expect(await readEtags(dataDir, provider, 'daily')).toEqual(seed);
      expect(sleptMs()).toEqual([25]);
    });

    it('rejects a read failure that outlasts the retries instead of reading it as no etags', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      failSidecarReads('EBUSY');

      await expect(readEtags(dataDir, provider, 'daily')).rejects.toMatchObject({ code: 'EBUSY' });
      expect(sleptMs()).toEqual(ALL_RETRY_DELAYS_MS);
    });

    it('rejects a non-transient read failure at once', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      failSidecarReads('EIO');

      await expect(readEtags(dataDir, provider, 'daily')).rejects.toMatchObject({ code: 'EIO' });
      expect(sidecarReads()).toBe(1);
      expect(sleptMs()).toEqual([]);
    });
  });

  describe('hasSyncedTier', () => {
    it('retries a transient stat failure of an existing sidecar', async () => {
      await seedSidecar({});
      failSidecarStats('EMFILE', 1);

      expect(await hasSyncedTier(dataDir, provider, 'daily')).toBe(true);
      expect(sleptMs()).toEqual([25]);
    });

    it('is false only when the sidecar does not exist', async () => {
      expect(await hasSyncedTier(dataDir, provider, 'daily')).toBe(false);
      expect(sleptMs()).toEqual([]);
    });

    it('rejects a stat failure that outlasts the retries instead of reading it as never synced', async () => {
      await seedSidecar({});
      failSidecarStats('EACCES');

      await expect(hasSyncedTier(dataDir, provider, 'daily')).rejects.toMatchObject({ code: 'EACCES' });
      expect(sleptMs()).toEqual(ALL_RETRY_DELAYS_MS);
    });

    it('rejects a non-transient stat failure at once', async () => {
      await seedSidecar({});
      failSidecarStats('EIO');

      await expect(hasSyncedTier(dataDir, provider, 'daily')).rejects.toMatchObject({ code: 'EIO' });
      expect(sleptMs()).toEqual([]);
    });
  });

  describe('getDataInventory', () => {
    const remote: readonly ManifestFileEntry[] = [
      { key: 'cur/data/billing_period=2026-01/a.parquet', contentHash: 'h-a', size: 10 },
      { key: 'cur/data/billing_period=2026-02/b.parquet', contentHash: 'h-b', size: 20 },
    ];

    /** Both periods downloaded and recorded as up to date. */
    async function seedSyncedPeriods(): Promise<void> {
      for (const period of ['2026-01', '2026-02']) {
        const dir = join(providerRawDir(dataDir, provider), `daily-${period}`);
        await fsActual.mkdir(dir, { recursive: true });
        await fsActual.writeFile(join(dir, 'data.parquet'), 'x');
      }
      await seedSidecar({
        '2026-01': { 'cur/data/billing_period=2026-01/a.parquet': 'h-a' },
        '2026-02': { 'cur/data/billing_period=2026-02/b.parquet': 'h-b' },
      });
    }

    const inventory = () => getDataInventory('s3://bucket/cur/', AWS_AUTH, dataDir, provider, 'daily', storeListing(remote));
    const statuses = async (): Promise<Record<string, string>> =>
      Object.fromEntries((await inventory()).periods.map(p => [p.period, p.localStatus]));

    it('reports recorded periods up to date', async () => {
      await seedSyncedPeriods();

      expect(await statuses()).toEqual({ '2026-01': 'repartitioned', '2026-02': 'repartitioned' });
    });

    it('retries a transient sidecar read instead of reporting every local period stale', async () => {
      await seedSyncedPeriods();
      failSidecarReads('EMFILE', 1);

      expect(await statuses()).toEqual({ '2026-01': 'repartitioned', '2026-02': 'repartitioned' });
      expect(sleptMs()).toEqual([25]);
    });

    it('rejects when the sidecar stays unreadable, so auto-sync cannot re-download the retention window', async () => {
      await seedSyncedPeriods();
      failSidecarReads('EBUSY');

      await expect(inventory()).rejects.toMatchObject({ code: 'EBUSY' });
    });

    it('rejects a non-transient sidecar read failure', async () => {
      await seedSyncedPeriods();
      failSidecarReads('EIO');

      await expect(inventory()).rejects.toMatchObject({ code: 'EIO' });
      expect(sidecarReads()).toBe(1);
    });

    it('still treats a tier with no sidecar as nothing verified yet', async () => {
      await seedSyncedPeriods();
      await fsActual.rm(etagPath());

      expect(await statuses()).toEqual({ '2026-01': 'stale', '2026-02': 'stale' });
    });
  });
});
