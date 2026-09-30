import { mkdtemp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManifestFileEntry } from '../sync/manifest.js';
import { providerEtagPath, providerMetaDir } from '../sync/provider-paths.js';
import { pruneEtagPeriod, saveEtags } from '../sync/sync-utils.js';
import { asProviderName } from '../types/branded.js';

// Every test runs against a real tmp dir. The three fs calls the sidecar
// update goes through are pass-through wrappers, so a test that needs a
// failure at one precise point — an EMFILE read, a writer killed mid-write,
// another thread's replace landing mid-update — injects it with a `...Once`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
  };
});
vi.mock('../logger/logger.js');

// Unwrapped fs, for seeding/inspecting the sidecar and for the "other thread"
// writes the injected hooks perform.
const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

type Sidecar = Record<string, Record<string, string>>;

const provider = asProviderName('aws');
const entry = (key: string, contentHash: string): ManifestFileEntry => ({ key, contentHash, size: 1 });
const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });

describe('etag sidecar updates', () => {
  let dataDir: string;

  const etagPath = (tier = 'daily'): string => providerEtagPath(dataDir, provider, tier);
  const metaDir = (): string => providerMetaDir(dataDir, provider);

  async function readSidecar(tier = 'daily'): Promise<unknown> {
    return JSON.parse(await fsActual.readFile(etagPath(tier), 'utf-8'));
  }

  async function seedSidecar(content: Sidecar, tier = 'daily'): Promise<void> {
    await fsActual.mkdir(metaDir(), { recursive: true });
    await fsActual.writeFile(etagPath(tier), JSON.stringify(content, null, 2));
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
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset();
    vi.mocked(rename).mockReset();
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

    it.each(['EMFILE', 'EBUSY', 'EPERM'])(
      'propagates a %s read failure instead of treating it as a first save',
      async (code) => {
        const seed: Sidecar = {
          '2026-01': { 'k/a.parquet': 'h-a' },
          '2026-02': { 'k/b.parquet': 'h-b' },
        };
        await seedSidecar(seed);
        vi.mocked(readFile).mockRejectedValueOnce(errno(code));

        await expect(saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]))
          .rejects.toMatchObject({ code });

        // Every other period is still recorded as up to date.
        expect(await readSidecar()).toEqual(seed);
      },
    );

    it('keeps the previous sidecar intact when the writer dies mid-write', async () => {
      const seed: Sidecar = {
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      };
      await seedSidecar(seed);
      // The worker is terminated part-way through the write: some bytes land,
      // the rest never do.
      vi.mocked(writeFile).mockImplementationOnce(async (file, data) => {
        await fsActual.writeFile(file, typeof data === 'string' ? data.slice(0, 12) : '');
        throw errno('EIO');
      });

      await expect(saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]))
        .rejects.toMatchObject({ code: 'EIO' });

      expect(await readSidecar()).toEqual(seed);
      expect(await readdir(metaDir())).toEqual(['sync-etags.json']);

      // And the next save still merges on top of it.
      await saveEtags(dataDir, provider, 'daily', '2026-03', [entry('k/c.parquet', 'h-c')]);
      expect(await readSidecar()).toEqual({ ...seed, '2026-03': { 'k/c.parquet': 'h-c' } });
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

    it('still commits, boundedly, when the sidecar keeps changing underneath', async () => {
      await seedSidecar({});
      let foreignWrites = 0;
      vi.mocked(writeFile).mockImplementation(async (file, data, options) => {
        foreignWrites++;
        await foreignReplace({ [`2025-${String(foreignWrites).padStart(2, '0')}`]: {} });
        await fsActual.writeFile(file, data, options);
      });

      await saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]);

      expect(await readSidecar()).toMatchObject({ '2026-01': { 'k/a.parquet': 'h-a' } });
      expect(foreignWrites).toBeLessThanOrEqual(5);
    });

    it('serializes concurrent saves in the same thread so none is lost', async () => {
      const periods = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];

      await Promise.all(periods.map(p => saveEtags(dataDir, provider, 'daily', p, [entry(`k/${p}.parquet`, `h-${p}`)])));

      expect(await readSidecar()).toEqual(Object.fromEntries(periods.map(p => [p, { [`k/${p}.parquet`]: `h-${p}` }])));
    });

    it('retries a rename briefly blocked by another process (Windows scanner/indexer)', async () => {
      await seedSidecar({ '2026-01': { 'k/a.parquet': 'h-a' } });
      vi.mocked(rename).mockRejectedValueOnce(errno('EPERM')).mockRejectedValueOnce(errno('EBUSY'));

      await saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]);

      expect(rename).toHaveBeenCalledTimes(3);
      expect(await readSidecar()).toEqual({
        '2026-01': { 'k/a.parquet': 'h-a' },
        '2026-02': { 'k/b.parquet': 'h-b' },
      });
      expect(await readdir(metaDir())).toEqual(['sync-etags.json']);
    });

    it('gives up on a rename that stays blocked, leaving the sidecar and no temp file', async () => {
      const seed: Sidecar = { '2026-01': { 'k/a.parquet': 'h-a' } };
      await seedSidecar(seed);
      vi.mocked(rename).mockRejectedValue(errno('EPERM'));

      await expect(saveEtags(dataDir, provider, 'daily', '2026-02', [entry('k/b.parquet', 'h-b')]))
        .rejects.toMatchObject({ code: 'EPERM' });

      expect(await readSidecar()).toEqual(seed);
      expect(await readdir(metaDir())).toEqual(['sync-etags.json']);
    });

    it('does not retry a rename that fails for a reason a retry cannot fix', async () => {
      await seedSidecar({});
      vi.mocked(rename).mockRejectedValueOnce(errno('ENOSPC'));

      await expect(saveEtags(dataDir, provider, 'daily', '2026-01', [entry('k/a.parquet', 'h-a')]))
        .rejects.toMatchObject({ code: 'ENOSPC' });
      expect(rename).toHaveBeenCalledTimes(1);
    });
  });

  describe('pruneEtagPeriod', () => {
    it('drops the period and its day-keyed entries, keeping everything else', async () => {
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

    it('never creates a sidecar that does not exist', async () => {
      // A missing sidecar is how the app tells "never synced" apart from
      // "synced before" (hasSyncedTier); a prune must not flip that.
      await pruneEtagPeriod(dataDir, provider, 'daily', '2026-03');

      await expect(fsActual.stat(etagPath())).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('does not rewrite the sidecar when nothing matches', async () => {
      await seedSidecar({ '2026-04': { 'k/n.parquet': 'h-n' } });

      await pruneEtagPeriod(dataDir, provider, 'daily', '2026-03');

      expect(writeFile).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    });

    it('propagates a non-ENOENT read failure without writing', async () => {
      const seed: Sidecar = { '2026-03': { 'k/m.parquet': 'h-m' } };
      await seedSidecar(seed);
      vi.mocked(readFile).mockRejectedValueOnce(errno('EMFILE'));

      await expect(pruneEtagPeriod(dataDir, provider, 'daily', '2026-03')).rejects.toMatchObject({ code: 'EMFILE' });
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
});
