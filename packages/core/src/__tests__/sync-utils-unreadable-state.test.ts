import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { hasSyncedTier, listLocalMonths, LocalSyncStateError, readEtags } from '../sync/sync-utils.js';
import { asProviderName } from '../types/branded.js';

/** Local sync state that exists but is not what it should be: a raw/ entry
 *  named like a period directory that is a file, an etag sidecar path that is
 *  a directory, and failures that carry no errno code. Real tmp dir
 *  throughout; `stat` is a pass-through wrapper so one case can inject a
 *  failure at that precise call. */

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const provider = asProviderName('aws-main');
const READ_ADVICE = 'Check that CostGoblin\'s data folder is readable, then retry.';

describe('sync-utils over unreadable local state', () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dataDir = await mkdtemp(join(tmpdir(), 'sync-utils-state-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('lists only period directories holding Parquet, skipping a file named like one', async () => {
    const rawDir = join(dataDir, String(provider), 'raw');
    await mkdir(join(rawDir, 'daily-2026-01'), { recursive: true });
    await writeFile(join(rawDir, 'daily-2026-01', 'part-0.parquet'), 'PAR1');
    // DuckDB's read_parquet would error on a glob with nothing to read here.
    await writeFile(join(rawDir, 'daily-2026-02'), 'PAR1');

    expect(await listLocalMonths(dataDir, provider, 'daily')).toEqual(['2026-01']);
  });

  it('refuses an etag sidecar it cannot read, naming the errno but not the path', async () => {
    // A directory where the sidecar should be: there IS state, it is just not
    // readable, so it must not read as "never synced" (every period stale).
    await mkdir(join(dataDir, String(provider), 'meta', 'sync-etags.json'), { recursive: true });

    const failure = await readEtags(dataDir, provider, 'daily').then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(LocalSyncStateError);
    expect(failure).toHaveProperty('message', `Could not read the saved daily sync state (EISDIR). ${READ_ADVICE}`);
    expect(String(failure)).not.toContain(dataDir);
  });

  it.each([
    ['an Error with no code', new Error('read failed')],
    ['an Error whose code is not text', Object.assign(new Error('read failed'), { code: -5 })],
    ['a value that is not an Error', 'read failed'],
  ])('reports %s as an unexpected error, keeping it as the cause', (_label, cause) => {
    const error = new LocalSyncStateError('the downloaded daily data', cause);

    expect(error.name).toBe('LocalSyncStateError');
    expect(error.message).toBe(`Could not read the downloaded daily data (unexpected error). ${READ_ADVICE}`);
    expect(error.cause).toBe(cause);
  });

  it('counts a tier as synced, and logs the failure text, when checking it fails with a non-Error', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    vi.mocked(stat).mockRejectedValueOnce('EIO: i/o error');

    expect(await hasSyncedTier(dataDir, provider, 'hourly')).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      'Could not check whether the hourly tier was synced before — counting it as synced',
      { provider: 'aws-main', error: 'EIO: i/o error' },
    );
  });
});
