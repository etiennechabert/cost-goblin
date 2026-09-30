import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataInventory } from '../sync/data-inventory.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import type { ObjectStoreHandle, ProviderAuth } from '../sync/object-store.js';
import { providerEtagPath, providerMetaDir, providerRawDir } from '../sync/provider-paths.js';
import { hasSyncedTier, LocalSyncStateError, pruneEtagPeriod, readEtags, saveEtags } from '../sync/sync-utils.js';
import { asProviderName } from '../types/branded.js';

// Every test runs against a real tmp dir. The fs calls the sidecar reads and
// updates go through are pass-through wrappers, so a test that needs a failure
// at one precise point — an EMFILE read, a writer killed mid-write, another
// thread's replace landing mid-update — injects it with a `...Once`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    stat: vi.fn(actual.stat),
    readdir: vi.fn(actual.readdir),
  };
});
// Retry backoff resolves at once; tests assert the delays it asked for.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(() => Promise.resolve()) }));
vi.mock('../logger/logger.js');

// Unwrapped fs, for seeding/inspecting the sidecar and for the "other thread"
// writes the injected hooks perform.
const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

type Sidecar = Record<string, Record<string, string>>;

const provider = asProviderName('aws');
const entry = (key: string, contentHash: string): ManifestFileEntry => ({ key, contentHash, size: 1 });
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });
const sleptMs = (): unknown[] => vi.mocked(sleep).mock.calls.map(([ms]) => ms);
const ALL_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];

describe('etag sidecar', () => {
  let dataDir: string;

  const etagPath = (tier = 'daily'): string => providerEtagPath(dataDir, provider, tier);
  const metaDir = (): string => providerMetaDir(dataDir, provider);
  const tempFiles = async (): Promise<string[]> => (await readdir(metaDir())).filter(name => name.endsWith('.tmp'));

  async function readSidecar(tier = 'daily'): Promise<unknown> {
    return JSON.parse(await fsActual.readFile(etagPath(tier), 'utf-8'));
  }

  async function seedSidecar(content: Sidecar): Promise<void> {
    await fsActual.mkdir(metaDir(), { recursive: true });
    await fsActual.writeFile(etagPath(), JSON.stringify(content, null, 2));
  }

  /** What another thread does to the sidecar: an atomic replace (temp file +
   *  rename), exactly like the code under test. */
  async function foreignReplace(content: Sidecar): Promise<void> {
    const tmp = `${etagPath()}.foreign.tmp`;
    await fsActual.writeFile(tmp, JSON.stringify(content, null, 2));
    await fsActual.rename(tmp, etagPath());
  }

  /** Runs `beforeWrite` once, just before the next sidecar write reaches the
   *  disk — i.e. after the updater has read the sidecar, before it commits. */
  function interleaveBeforeNextWrite(beforeWrite: () => Promise<void>): void {
    vi.mocked(writeFile).mockImplementationOnce(async (file, data, options) => {
      await beforeWrite();
      await fsActual.writeFile(file, data, options);
    });
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'costgoblin-etags-'));
  });

  afterEach(async () => {
    // Restores the pass-through implementations and drops any unconsumed
    // `...Once` so one test's injection can never leak into the next.
    for (const fn of [readFile, writeFile, rename, rm, stat, readdir]) vi.mocked(fn).mockReset();
    vi.mocked(sleep).mockClear();
    await fsActual.rm(dataDir, { recursive: true, force: true });
  });

  describe('saveEtags', () => {
    it('creates the sidecar on the first save of a tier', async () => {
      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]);

      expect(await readSidecar()).toEqual({ '2026-01': { 'k/a.parquet': 'h-a' } });
    });

    it('merges into the existing sidecar, replacing only the saved period', async () => {
      await seedSidecar({
        '2026-01': { 'k/old.parquet': 'h-old' },
        '2026-02': { 'k/b.parquet': 'h-b1', 'k/gone.parquet': 'h-gone' },
      });

      await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b2')]);

      expect(await readSidecar()).toEqual({
        '2026-01': { 'k/old.parquet': 'h-old' },
        '2026-02': { 'k/b.parquet': 'h-b2' },
      });
    });

    it('writes each tier to its own sidecar', async () => {
      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('d.parquet', 'h-d')]);
      await saveEtags(dataDir, provider, 'hourly', '2026-01', [entry('h.parquet', 'h-h')]);

      expect(await readSidecar('daily')).toEqual({ '2026-01': { 'd.parquet': 'h-d' } });
      expect(await readSidecar('hourly')).toEqual({ '2026-01': { 'h.parquet': 'h-h' } });
    });

    it('flushes the temp file to disk before renaming it over the sidecar', async () => {
      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]);

      expect(writeFile).toHaveBeenCalledWith(
        expect.stringMatching(/sync-etags\.json\.[\w-]+\.tmp$/),
        expect.any(String),
        { flush: true },
      );
      const [writeOrder] = vi.mocked(writeFile).mock.invocationCallOrder;
      const [renameOrder] = vi.mocked(rename).mock.invocationCallOrder;
      expect(writeOrder).toBeLessThan(renameOrder ?? 0);
    });

    it.each(['EMFILE', 'EBUSY', 'EPERM', 'EACCES'])(
      'retries a transient %s read, then merges as usual',
      async (code) => {
        await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
        vi.mocked(readFile).mockRejectedValueOnce(errno(code));

        await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]);

        expect(await readSidecar()).toEqual({
          '2026-01': { 'k/a.parquet': 'h-a' },
          '2026-02': { 'k/b.parquet': 'h-b' },
        });
        expect(sleptMs()).toEqual([25]);
      },
    );

    it('propagates a read failure that outlasts the retries instead of treating it as a first save', async () => {
      const seed: Sidecar = {
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      };
      await seedSidecar(seed);
      vi.mocked(readFile).mockRejectedValue(errno('EBUSY'));

      await expect(saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]))
        .rejects.toMatchObject({ code: 'EBUSY' });

      // Every other period is still recorded as up to date.
      expect(await readSidecar()).toEqual(seed);
      expect(sleptMs()).toEqual(ALL_RETRY_DELAYS_MS);
    });

    it('propagates a non-transient read failure at once, without writing', async () => {
      const seed: Sidecar = { '2026-01': { 'k/a.parquet': 'h-a' } };
      await seedSidecar(seed);
      vi.mocked(readFile).mockRejectedValueOnce(errno('EIO'));

      await expect(saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]))
        .rejects.toMatchObject({ code: 'EIO' });

      expect(readFile).toHaveBeenCalledTimes(1);
      expect(writeFile).not.toHaveBeenCalled();
      expect(await readSidecar()).toEqual(seed);
    });

    it('retries a temp write briefly blocked by a scanner', async () => {
      vi.mocked(writeFile).mockRejectedValueOnce(errno('EBUSY'));

      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]);

      expect(writeFile).toHaveBeenCalledTimes(2);
      expect(await readSidecar()).toEqual({ '2026-01': { 'k/a.parquet': 'h-a' } });
    });

    it('keeps the previous sidecar intact when the writer is killed mid-write', async () => {
      const seed: Sidecar = {
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      };
      await seedSidecar(seed);
      // The worker is terminated part-way through the write: some bytes land,
      // the rest never do, and the dead thread's cleanup never runs.
      vi.mocked(writeFile).mockImplementationOnce(async (file, data) => {
        await fsActual.writeFile(file, typeof data === 'string' ? data.slice(0, 12) : '');
        throw errno('EIO');
      });
      vi.mocked(rm).mockResolvedValueOnce(undefined);

      await expect(saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]))
        .rejects.toMatchObject({ code: 'EIO' });

      expect(await readSidecar()).toEqual(seed);
      expect(await tempFiles()).toHaveLength(1);
    });

    it('sweeps a temp file orphaned by a killed writer once it is stale', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      const orphan = `${etagPath()}.dead-writer.tmp`;
      await fsActual.writeFile(orphan, '{"2026-0');
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fsActual.utimes(orphan, twoHoursAgo, twoHoursAgo);

      await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]);

      expect(await readdir(metaDir())).toEqual(['sync-etags.json']);
      expect(await readSidecar()).toEqual({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      });
    });

    it('leaves a recent temp file alone — it may be another thread\'s update in flight', async () => {
      await seedSidecar({});
      const inFlight = `${etagPath()}.other-thread.tmp`;
      await fsActual.writeFile(inFlight, '{}');

      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]);

      expect(await tempFiles()).toEqual(['sync-etags.json.other-thread.tmp']);
    });

    it('keeps a period another thread saved while this save was in flight', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      interleaveBeforeNextWrite(() => foreignReplace({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-04': { 'k/d.parquet': 'h-d' },
      }));

      await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]);

      expect(await readSidecar()).toEqual({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
        '2026-04': { 'k/d.parquet': 'h-d' },
      });
    });

    it('does not resurrect a period another thread pruned while this save was in flight', async () => {
      await seedSidecar({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      });
      interleaveBeforeNextWrite(() => foreignReplace({ '2026-02': { 'k/b.parquet': 'h-b' } }));

      await saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]);

      expect(await readSidecar()).toEqual({
        '2026-02': { 'k/b.parquet': 'h-b' },
        '2026-03': { 'k/c.parquet': 'h-c' },
      });
    });

    it('re-checks the sidecar before retrying a blocked rename', async () => {
      await seedSidecar({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      });
      // The main thread's prune commits while this save's rename is blocked.
      vi.mocked(rename).mockImplementationOnce(async () => {
        await foreignReplace({ '2026-02': { 'k/b.parquet': 'h-b' } });
        throw errno('EPERM');
      });

      await saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]);

      expect(await readSidecar()).toEqual({
        '2026-02': { 'k/b.parquet': 'h-b' },
        '2026-03': { 'k/c.parquet': 'h-c' },
      });
    });

    it('gives up, boundedly, rather than overwrite a sidecar that keeps changing underneath', async () => {
      await seedSidecar({});
      let foreignWrites = 0;
      vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
        foreignWrites++;
        await foreignReplace({ [`2025-${String(foreignWrites).padStart(2, '0')}`]: {} });
        await fsActual.writeFile(file, data, options);
      });

      await expect(saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]))
        .rejects.toThrow(/kept changing/);

      // The other thread's last write stands; nothing stale was merged back in.
      expect(await readSidecar()).toEqual({ '2025-06': {} });
      expect(foreignWrites).toBe(6);
      expect(await tempFiles()).toEqual([]);
    });

    it('serializes concurrent saves to one sidecar so none is lost', async () => {
      const periods = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

      await Promise.all(periods.map(p => saveEtags(dataDir, provider, 'daily', p, [entry(`k/${p}.parquet`, `h-${p}`)])));

      expect(await readSidecar()).toEqual(Object.fromEntries(periods.map(p => [p, { [`k/${p}.parquet`]: `h-${p}` }])));
    });

    it('never makes one sidecar wait on another', async () => {
      let entered = (): void => undefined;
      const dailyEntered = new Promise<void>((resolve) => { entered = resolve; });
      let release = (): void => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      vi.mocked(readFile).mockImplementation(async (file, options) => {
        if (file === etagPath('daily')) {
          entered();
          await gate;
        }
        return fsActual.readFile(file, options);
      });

      // The daily update is queued and stuck mid-update before the hourly one starts.
      const daily = saveEtags(dataDir, provider, 'daily', '2026-01', [entry('d.parquet', 'h-d')]);
      await dailyEntered;
      await saveEtags(dataDir, provider, 'hourly', '2026-01', [entry('h.parquet', 'h-h')]);
      expect(await readSidecar('hourly')).toEqual({ '2026-01': { 'h.parquet': 'h-h' } });

      release();
      await daily;
      expect(await readSidecar('daily')).toEqual({ '2026-01': { 'd.parquet': 'h-d' } });
    });

    it('retries a rename briefly blocked by another process (Windows scanner/indexer)', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      vi.mocked(rename).mockRejectedValueOnce(errno('EPERM')).mockRejectedValueOnce(errno('EBUSY'));

      await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]);

      expect(rename).toHaveBeenCalledTimes(3);
      expect(sleptMs()).toEqual([25, 50]);
      expect(await readSidecar()).toEqual({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      });
      expect(await tempFiles()).toEqual([]);
    });

    it('gives up on a rename that stays blocked, leaving the sidecar and no temp file', async () => {
      const seed: Sidecar = { '2026-01': { 'k/a.parquet': 'h-a' } };
      await seedSidecar(seed);
      vi.mocked(rename).mockRejectedValue(errno('EPERM'));

      await expect(saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]))
        .rejects.toMatchObject({ code: 'EPERM' });

      expect(rename).toHaveBeenCalledTimes(7);
      expect(sleptMs()).toEqual([25, 50, 100, 200, 400, 800]);
      expect(await readSidecar()).toEqual(seed);
      expect(await tempFiles()).toEqual([]);
    });

    it('does not retry a rename that fails for a reason a retry cannot fix', async () => {
      await seedSidecar({});
      vi.mocked(rename).mockRejectedValueOnce(errno('ENOSPC'));

      await expect(saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]))
        .rejects.toMatchObject({ code: 'ENOSPC' });
      expect(rename).toHaveBeenCalledTimes(1);
      expect(sleptMs()).toEqual([]);
    });
  });

  describe('pruneEtagPeriod', () => {
    it('drops the period and any key under it, keeping everything else', async () => {
      await seedSidecar({
        '2026-03': { 'k/m.parquet': 'h-m' },
        '2026-03-15': { 'k/d.parquet': 'h-d' },
        '2026-04': { 'k/n.parquet': 'h-n' },
        '2026-04-01': { 'k/e.parquet': 'h-e' },
      });

      await pruneEtagPeriod(dataDir, provider, 'daily', '2026-03');

      expect(await readSidecar()).toEqual({
        '2026-04': { 'k/n.parquet': 'h-n' },
        '2026-04-01': { 'k/e.parquet': 'h-e' },
      });
    });

    it.each(['2026', '2026-3', '2026-03-1', '../2026-03'])('rejects a malformed period %j without touching the sidecar', async (period) => {
      const seed: Sidecar = { '2026-03': { 'k/m.parquet': 'h-m' } };
      await seedSidecar(seed);

      await expect(pruneEtagPeriod(dataDir, provider, 'daily', period)).rejects.toThrow(/Invalid period/);
      expect(await readSidecar()).toEqual(seed);
    });

    it('never creates a sidecar that does not exist', async () => {
      // A missing sidecar is how the app tells "never synced" apart from
      // "synced before" (hasSyncedTier); a prune must not flip that.
      await pruneEtagPeriod(dataDir, provider, 'daily', '2026-03');

      await expect(fsActual.stat(etagPath())).rejects.toMatchObject({ code: 'ENOENT' });
      expect(rm).not.toHaveBeenCalled();
    });

    it('does not rewrite the sidecar when nothing matches', async () => {
      await seedSidecar({ '2026-04': { 'k/n.parquet': 'h-n' } });

      await pruneEtagPeriod(dataDir, provider, 'daily', '2026-03');

      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    });

    it('propagates a read failure without writing', async () => {
      const seed: Sidecar = { '2026-03': { 'k/m.parquet': 'h-m' } };
      await seedSidecar(seed);
      vi.mocked(readFile).mockRejectedValueOnce(errno('EIO'));

      await expect(pruneEtagPeriod(dataDir, provider, 'daily', '2026-03')).rejects.toMatchObject({ code: 'EIO' });
      expect(await readSidecar()).toEqual(seed);
    });

    it('does not drop a period the sync worker saved while the prune was in flight', async () => {
      await seedSidecar({
        '2026-03': { 'k/m.parquet': 'h-m' },
        '2026-04': { 'k/n.parquet': 'h-n' },
      });
      interleaveBeforeNextWrite(() => foreignReplace({
        '2026-03': { 'k/m.parquet': 'h-m' },
        '2026-04': { 'k/n.parquet': 'h-n' },
        '2026-05': { 'k/o.parquet': 'h-o' },
      }));

      await pruneEtagPeriod(dataDir, provider, 'daily', '2026-03');

      expect(await readSidecar()).toEqual({
        '2026-04': { 'k/n.parquet': 'h-n' },
        '2026-05': { 'k/o.parquet': 'h-o' },
      });
    });
  });

  describe('readEtags', () => {
    it('is empty for a tier with no sidecar yet', async () => {
      expect(await readEtags(dataDir, provider, 'daily')).toEqual({});
      expect(sleptMs()).toEqual([]);
    });

    it('reads back what saveEtags recorded', async () => {
      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]);
      await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]);

      expect(await readEtags(dataDir, provider, 'daily')).toEqual({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      });
    });

    it.each(['EMFILE', 'EBUSY', 'EPERM', 'EACCES'])('retries a transient %s read', async (code) => {
      const seed: Sidecar = { '2026-01': { 'k/a.parquet': 'h-a' } };
      await seedSidecar(seed);
      vi.mocked(readFile).mockRejectedValueOnce(errno(code));

      expect(await readEtags(dataDir, provider, 'daily')).toEqual(seed);
      expect(sleptMs()).toEqual([25]);
    });

    it('rejects a read failure that outlasts the retries instead of reading it as no etags', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      vi.mocked(readFile).mockRejectedValue(errno('EBUSY'));

      const err: unknown = await readEtags(dataDir, provider, 'daily').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LocalSyncStateError);
      expect(err).toMatchObject({ cause: { code: 'EBUSY' } });
      expect(sleptMs()).toEqual(ALL_RETRY_DELAYS_MS);
    });

    it('rejects a non-transient read failure at once, without the path in its message', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      // Node puts the path in an fs error's message.
      vi.mocked(readFile).mockRejectedValueOnce(Object.assign(new Error(`EIO: i/o error, open '${etagPath()}'`), { code: 'EIO' }));

      const err: unknown = await readEtags(dataDir, provider, 'daily').catch((e: unknown) => e);

      expect(err).toBeInstanceOf(LocalSyncStateError);
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(sleptMs()).toEqual([]);
      // The credential classifiers match on message text, and the data dir
      // holds user-chosen names ('credentials-audit' is a valid workspace).
      expect(String(err)).not.toContain(dataDir);
    });
  });

  describe('hasSyncedTier', () => {
    it.each(['EMFILE', 'EACCES', 'EIO'])('counts a sidecar it cannot check (%s) as synced', async (code) => {
      vi.mocked(stat).mockRejectedValueOnce(errno(code));

      // No sidecar here, yet only a confirmed ENOENT may read as "never synced":
      // that answer hides a real credential failure behind local data.
      expect(await hasSyncedTier(dataDir, provider, 'daily')).toBe(true);
    });
  });

  describe('getDataInventory', () => {
    const AWS_AUTH: ProviderAuth = { kind: 'aws-profile', profile: 'default' };
    const remote = [
      entry('cur/data/billing_period=2026-01/a.parquet', 'h-a'),
      entry('cur/data/billing_period=2026-02/b.parquet', 'h-b'),
    ];
    const store: ObjectStoreHandle = {
      listFiles: () => Promise.resolve([...remote]),
      downloadFile: () => Promise.reject(new Error('downloadFile not used by the inventory')),
    };
    const inventory = () => getDataInventory('s3://bucket/cur/', AWS_AUTH, dataDir, provider, 'daily', store);
    const statuses = async (): Promise<Record<string, string>> =>
      Object.fromEntries((await inventory()).periods.map(p => [p.period, p.localStatus]));
    const UP_TO_DATE = { '2026-01': 'repartitioned', '2026-02': 'repartitioned' };

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

    /** Fails reads of the daily sidecar — the next `times`, or all of them —
     *  and passes every other read (the sync timestamps) through. */
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

    it('retries a transient sidecar read instead of reporting every local period stale', async () => {
      await seedSyncedPeriods();
      failSidecarReads('EMFILE', 1);

      expect(await statuses()).toEqual(UP_TO_DATE);
      expect(sleptMs()).toEqual([25]);
    });

    it('rejects when the sidecar stays unreadable, so auto-sync cannot re-download the retention window', async () => {
      await seedSyncedPeriods();
      failSidecarReads('EBUSY');

      await expect(inventory()).rejects.toBeInstanceOf(LocalSyncStateError);
    });

    it('retries a transient listing of the downloaded data instead of reporting every period missing', async () => {
      await seedSyncedPeriods();
      vi.mocked(readdir).mockRejectedValueOnce(errno('EMFILE'));

      expect(await statuses()).toEqual(UP_TO_DATE);
      expect(sleptMs()).toEqual([25]);
    });

    it('rejects when the downloaded data cannot be listed, rather than reporting every period missing', async () => {
      await seedSyncedPeriods();
      vi.mocked(readdir).mockRejectedValue(errno('EIO'));

      await expect(inventory()).rejects.toBeInstanceOf(LocalSyncStateError);
    });
  });
});
