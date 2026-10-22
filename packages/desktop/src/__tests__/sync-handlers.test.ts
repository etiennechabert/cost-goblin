import { ChildProcess, spawn } from 'node:child_process';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LocalSyncStateError,
  findAwsCli,
  findGcloudCli,
  getDataInventory,
  providerEtagPath,
  writeTierLastSync,
} from '@costgoblin/core';
import type { DataInventory, ManifestFileEntry, ProviderName, SyncProgress } from '@costgoblin/core';
import { triggerAutoSyncNow } from '../main/auto-sync.js';
import { changedRollupMonths, deleteLocalPeriodFiles, resolveDataType, registerSyncHandlers } from '../main/handlers/sync.js';
import { SYNC_ALREADY_RUNNING } from '../main/sync-client.js';
import { resetElectronFakes, shell } from './helpers/electron-fake.js';
import {
  FIXTURE_AWS_PROVIDER,
  FIXTURE_GCP_PROVIDER,
  at,
  createHarness,
  type FixtureConfigSet,
  type Harness,
} from './helpers/ipc-harness.js';

/** The sync / data-management IPC channels: status backfill, inventory and
 *  its local-only fallback, delete + prune cascades into the rollup, the
 *  selective-sync orchestration around a scripted SyncClient, cancellation,
 *  and the CLI sign-in launchers. The object-store listing and the CLI
 *  binaries are the only things replaced — the real handlers, AppContext and
 *  on-disk layout are exercised. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('@costgoblin/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@costgoblin/core')>();
  return {
    ...actual,
    getDataInventory: vi.fn(),
    findAwsCli: vi.fn(() => null),
    findGcloudCli: vi.fn(() => null),
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});
vi.mock('../main/auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/auto-sync.js')>();
  return { ...actual, triggerAutoSyncNow: vi.fn() };
});

const AWS = FIXTURE_AWS_PROVIDER;
const harnesses: Harness[] = [];

beforeEach(() => {
  resetElectronFakes();
  vi.mocked(getDataInventory).mockReset();
  vi.mocked(findAwsCli).mockReset().mockReturnValue(null);
  vi.mocked(findGcloudCli).mockReset().mockReturnValue(null);
  vi.mocked(spawn).mockReset();
  vi.mocked(triggerAutoSyncNow).mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function syncApp(config: FixtureConfigSet = 'single', data: 'synthetic' | 'none' = 'synthetic', now?: number): Promise<Harness> {
  const h = await createHarness({ config, data, ...(now === undefined ? {} : { now: () => now }) });
  registerSyncHandlers(h.app);
  harnesses.push(h);
  return h;
}

/** Replace the post-sync maintenance hooks with recorders: these tests assert
 *  what the handler asks for; the hooks' own work belongs to the AppContext
 *  suite (and must not keep querying after a test's harness is gone). */
function stubMaintenance(h: Harness) {
  return {
    maintain: vi.spyOn(h.app, 'maintainRollup').mockImplementation(() => undefined),
    warmup: vi.spyOn(h.app, 'warmupBase').mockImplementation(() => undefined),
    recompute: vi.spyOn(h.app, 'recomputeBaselines').mockImplementation(() => undefined),
  };
}

/** The first configured provider's (branded) name. */
async function firstProviderName(h: Harness): Promise<ProviderName> {
  const provider = (await h.app.getConfig()).providers[0];
  if (provider === undefined) throw new Error('fixture config has a provider');
  return provider.name;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

function rawDir(h: Harness, provider: string, dir: string): string {
  return join(h.ws.dataDir, provider, 'raw', dir);
}

const DAILY_FILES: ManifestFileEntry[] = [
  { key: 'focus/daily/data/billing_period=2026-02/part-0.parquet', contentHash: 'etag-a', size: 100 },
  { key: 'focus/daily/data/billing_period=2026-02/part-1.parquet', contentHash: 'etag-b', size: 100 },
];

function inventory(periods: DataInventory['periods']): DataInventory {
  return {
    periods,
    totalRemoteSize: periods.reduce((n, p) => n + p.totalSize, 0),
    totalLocalPeriods: 0,
    totalRemotePeriods: periods.length,
    lastSync: null,
    local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null },
  };
}

function credentialError(): Error {
  const err = new Error('The SSO session associated with this profile has expired or is otherwise invalid');
  err.name = 'CredentialsProviderError';
  return err;
}

describe('sync helpers', () => {
  it('maps legacy and composite sync ids to their tier', () => {
    expect(resolveDataType('default')).toBe('daily');
    expect(resolveDataType('aws-main:hourly')).toBe('hourly');
    expect(resolveDataType('cost-optimization')).toBe('cost-optimization');
  });

  it('reduces changed periods to unique rollup months, dropping unparseable ones', () => {
    expect(changedRollupMonths(['2026-02', '2026-02-14', '2026-01', 'unknown'])).toEqual(['2026-02', '2026-01']);
  });

  it('refuses a malformed period before touching disk', async () => {
    const h = await syncApp();
    const name = await firstProviderName(h);
    await expect(deleteLocalPeriodFiles(h.ws.dataDir, name, '2026-1', 'daily'))
      .rejects.toThrow('Invalid period format: "2026-1" — expected YYYY-MM or YYYY-MM-DD');
    await expect(deleteLocalPeriodFiles(h.ws.dataDir, name, '../2026-01', 'daily')).rejects.toThrow('Invalid period format');
    expect(await exists(rawDir(h, AWS, 'daily-2026-01'))).toBe(true);
  });
});

describe('sync:status', () => {
  it('is idle with no last sync while onboarding (no config, or no providers)', async () => {
    const h = await syncApp('none', 'none');
    expect(await h.ipc.invoke('sync:status')).toEqual({ status: 'idle', lastSync: null });

    const configured = await syncApp();
    const config = await configured.app.getConfig();
    configured.app.state.config = { ...config, providers: [] };
    expect(await configured.ipc.invoke('sync:status', 'default')).toEqual({ status: 'idle', lastSync: null });
  });

  it('reads the durable last-sync timestamp for a tier that is not syncing', async () => {
    const h = await syncApp();
    expect(await h.ipc.invoke('sync:status')).toEqual({ status: 'idle', lastSync: null });
    await writeTierLastSync(h.ws.dataDir, await firstProviderName(h), 'hourly', '2026-02-27T08:00:00.000Z');
    expect(await h.ipc.invoke('sync:status', 'hourly')).toEqual({ status: 'idle', lastSync: new Date('2026-02-27T08:00:00.000Z') });
    // A composite id addresses the same (provider, tier).
    expect(await h.ipc.invoke('sync:status', `${AWS}:hourly`)).toEqual({ status: 'idle', lastSync: new Date('2026-02-27T08:00:00.000Z') });
  });

  it('backfills lastSync on an idle/failed in-memory status, and reports a live status as is', async () => {
    const h = await syncApp();
    const failure = new Error('boom');
    h.app.state.syncStatuses[`${AWS}:daily`] = { status: 'failed', error: failure, lastSync: null };
    // No durable timestamp yet → the in-memory status unchanged.
    expect(await h.ipc.invoke('sync:status')).toEqual({ status: 'failed', error: failure, lastSync: null });

    await writeTierLastSync(h.ws.dataDir, await firstProviderName(h), 'daily', '2026-02-28T00:00:00.000Z');
    expect(await h.ipc.invoke('sync:status')).toEqual({ status: 'failed', error: failure, lastSync: new Date('2026-02-28T00:00:00.000Z') });

    const syncing = { status: 'syncing', phase: 'downloading', progress: 0.5, filesTotal: 2, filesDone: 1, bytesTotal: 10, bytesDone: 5, message: '' } as const;
    h.app.state.syncStatuses[`${AWS}:daily`] = syncing;
    expect(await h.ipc.invoke('sync:status')).toEqual(syncing);
  });
});

describe('data:inventory', () => {
  it('returns the remote inventory tagged with its provider, defaulting to the daily tier', async () => {
    const h = await syncApp();
    const inv = inventory([{ period: '2026-02', files: DAILY_FILES, totalSize: 200, localStatus: 'stale' }]);
    vi.mocked(getDataInventory).mockResolvedValueOnce(inv);
    expect(await h.ipc.invoke('data:inventory')).toEqual({ ...inv, provider: AWS });
    const call = vi.mocked(getDataInventory).mock.calls[0];
    expect(call?.[0]).toBe('s3://test-cur-bucket/daily/');
    expect(call?.[1]).toEqual({ kind: 'aws-profile', profile: 'test-profile' });
    expect(call?.[4]).toBe('daily');

    vi.mocked(getDataInventory).mockResolvedValueOnce(inv);
    await h.ipc.invoke('data:inventory', 'hourly');
    expect(vi.mocked(getDataInventory).mock.calls[1]?.[0]).toBe('s3://test-cur-bucket/hourly/');
  });

  it('surfaces unreadable local sync state instead of guessing', async () => {
    const h = await syncApp();
    const err = new LocalSyncStateError('the saved daily sync state', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    vi.mocked(getDataInventory).mockRejectedValueOnce(err);
    await expect(h.ipc.invoke('data:inventory')).rejects.toBe(err);
  });

  it('turns a credential failure on a tier synced before into the sign-in message', async () => {
    const h = await syncApp();
    const etags = providerEtagPath(h.ws.dataDir, await firstProviderName(h), 'daily');
    await mkdir(join(etags, '..'), { recursive: true });
    await writeFile(etags, '{}');
    vi.mocked(getDataInventory).mockRejectedValueOnce(credentialError());
    await expect(h.ipc.invoke('data:inventory')).rejects.toThrow(
      'AWS credentials expired for profile "test-profile". Run: aws sso login --profile test-profile',
    );
  });

  it('falls back to the local inventory for an imported snapshot with no sync history', async () => {
    const h = await syncApp();
    vi.mocked(getDataInventory).mockRejectedValueOnce(credentialError());
    const local = await h.ipc.invoke('data:inventory');
    expect(at(local, 'provider')).toBe(AWS);
    expect(at(local, 'totalLocalPeriods')).toBe(2);
    expect(at(local, 'local', 'periods')).toEqual(['2026-01', '2026-02']);

    // Any listing failure takes the same fallback while local data exists.
    vi.mocked(getDataInventory).mockRejectedValueOnce(new Error('socket hang up'));
    expect(at(await h.ipc.invoke('data:inventory', 'hourly'), 'local', 'periods')).toEqual(['2026-02']);
  });

  it('rethrows when there is no local data to fall back on (GCP wording for a GCP provider)', async () => {
    const h = await syncApp('multi', 'none');
    vi.mocked(getDataInventory).mockRejectedValueOnce(new Error('Could not load the default credentials. Browse to …'));
    await expect(h.ipc.invoke('data:inventory', 'daily', FIXTURE_GCP_PROVIDER)).rejects.toThrow(
      'GCP credentials are missing or expired. Run: gcloud auth application-default login',
    );
    const plain = new Error('NoSuchBucket: The specified bucket does not exist');
    vi.mocked(getDataInventory).mockRejectedValueOnce(plain);
    await expect(h.ipc.invoke('data:inventory')).rejects.toBe(plain);
  });

  it('rejects an unknown provider name', async () => {
    const h = await syncApp();
    await expect(h.ipc.invoke('data:inventory', 'daily', 'nope')).rejects.toThrow('Unknown provider "nope"');
    expect(getDataInventory).not.toHaveBeenCalled();
  });
});

describe('data:local-inventory', () => {
  it('reads the on-disk periods without listing the remote, defaulting to the daily tier', async () => {
    const h = await syncApp();
    const local = await h.ipc.invoke('data:local-inventory');
    expect(at(local, 'provider')).toBe(AWS);
    expect(at(local, 'local', 'periods')).toEqual(['2026-01', '2026-02']);
    expect(at(local, 'local', 'oldestPeriod')).toBe('2026-01');
    expect(at(await h.ipc.invoke('data:local-inventory', 'hourly'), 'local', 'periods')).toEqual(['2026-02']);
    expect(getDataInventory).not.toHaveBeenCalled();
  });

  it('rejects an unknown provider name', async () => {
    const h = await syncApp();
    await expect(h.ipc.invoke('data:local-inventory', 'daily', 'nope')).rejects.toThrow('Unknown provider "nope"');
  });
});

describe('data:delete-period and data:prune', () => {
  it('deletes a whole daily month and drops its rollup partition', async () => {
    const h = await syncApp();
    const deletePeriod = vi.spyOn(h.app.rollupStore, 'deletePeriod');
    const { maintain } = stubMaintenance(h);
    await h.ipc.invoke('data:delete-period', '2026-02');
    expect(await exists(rawDir(h, AWS, 'daily-2026-02'))).toBe(false);
    expect(await exists(rawDir(h, AWS, 'daily-2026-01'))).toBe(true);
    expect(deletePeriod).toHaveBeenCalledWith('2026-02');
    expect(maintain).not.toHaveBeenCalled();
  });

  it('re-rolls a month that still has data after a day-level delete matched nothing', async () => {
    const h = await syncApp();
    const { maintain } = stubMaintenance(h);
    await h.ipc.invoke('data:delete-period', '2026-01-15');
    expect(await exists(rawDir(h, AWS, 'daily-2026-01'))).toBe(true);
    expect(maintain).toHaveBeenCalledWith(['2026-01']);
  });

  it('does not cascade a non-daily tier or a non-first provider into the rollup', async () => {
    const h = await syncApp('multi');
    const deletePeriod = vi.spyOn(h.app.rollupStore, 'deletePeriod');
    const { maintain } = stubMaintenance(h);
    await h.ipc.invoke('data:delete-period', '2026-02', 'hourly');
    expect(await exists(rawDir(h, AWS, 'hourly-2026-02'))).toBe(false);
    await h.ipc.invoke('data:delete-period', '2026-01', 'daily', FIXTURE_GCP_PROVIDER);
    expect(await exists(rawDir(h, FIXTURE_GCP_PROVIDER, 'daily-2026-01'))).toBe(false);
    expect(await exists(rawDir(h, AWS, 'daily-2026-01'))).toBe(true);
    expect(deletePeriod).not.toHaveBeenCalled();
    expect(maintain).not.toHaveBeenCalled();
  });

  it('still deletes the raw data when the etag sidecar cannot be pruned', async () => {
    const h = await syncApp();
    // A directory where the sidecar file belongs: reading it fails.
    await mkdir(providerEtagPath(h.ws.dataDir, await firstProviderName(h), 'cost-optimization'), { recursive: true });
    await h.ipc.invoke('data:delete-period', '2026-02', 'cost-optimization');
    expect(await exists(rawDir(h, AWS, 'cost-opt-2026-02'))).toBe(false);
  });

  it('prunes every provider\'s expired periods per tier retention, cascading only the first provider\'s daily months', async () => {
    const h = await syncApp('multi', 'synthetic', Date.parse('2027-06-15T00:00:00Z'));
    const deletePeriod = vi.spyOn(h.app.rollupStore, 'deletePeriod');
    const result = await h.ipc.invoke('data:prune');
    const deleted = at(result, 'deleted');
    expect(deleted).toEqual(expect.arrayContaining([
      { tier: 'daily', period: '2026-01', provider: AWS },
      { tier: 'daily', period: '2026-02', provider: AWS },
      { tier: 'hourly', period: '2026-02', provider: AWS },
      { tier: 'cost-optimization', period: '2026-02', provider: AWS },
      { tier: 'daily', period: '2026-01', provider: FIXTURE_GCP_PROVIDER },
      { tier: 'daily', period: '2026-02', provider: FIXTURE_GCP_PROVIDER },
    ]));
    expect(Array.isArray(deleted) ? deleted.length : 0).toBe(6);
    expect(deletePeriod.mock.calls.map(c => c[0]).sort()).toEqual(['2026-01', '2026-02']);
    expect(await exists(rawDir(h, FIXTURE_GCP_PROVIDER, 'daily-2026-02'))).toBe(false);
  });

  it('prunes nothing inside the retention window', async () => {
    const h = await syncApp();
    expect(await h.ipc.invoke('data:prune')).toEqual({ deleted: [] });
    expect(await exists(rawDir(h, AWS, 'daily-2026-01'))).toBe(true);
  });

  it('refuses to prune with no provider configured', async () => {
    const h = await syncApp();
    const config = await h.app.getConfig();
    h.app.state.config = { ...config, providers: [] };
    await expect(h.ipc.invoke('data:prune')).rejects.toThrow('No provider configured');
  });
});

describe('data:sync-periods', () => {
  it('drives a daily sync: live progress, completion, durable timestamp, rollup + baseline refresh', async () => {
    const h = await syncApp();
    const { maintain, recompute, warmup } = stubMaintenance(h);
    const seen: unknown[] = [];
    h.sync.syncPeriods.mockImplementationOnce(async (options) => {
      const report = (progress: SyncProgress): void => { options.onProgress?.(progress); };
      // Before the file list is known nothing can be measured yet.
      report({ phase: 'downloading', filesTotal: 0, filesDone: 0 });
      seen.push(at(await h.ipc.invoke('sync:status'), 'progress'));
      report({ phase: 'downloading', filesTotal: 2, filesDone: 0 });
      seen.push(await h.ipc.invoke('sync:status'));
      report({ phase: 'downloading', filesTotal: 2, filesDone: 1 });
      seen.push(await h.ipc.invoke('sync:status'));
      report({ phase: 'repartitioning', filesTotal: 2, filesDone: 1, bytesTotal: 400, bytesDone: 100, message: 'Completed 100 B' });
      seen.push(await h.ipc.invoke('sync:status'));
      // A second request for the same provider/tier coalesces into this one.
      seen.push(await h.ipc.invoke('data:sync-periods', DAILY_FILES));
      return { filesDownloaded: 2, rowsProcessed: 42 };
    });

    const result = await h.ipc.invoke('data:sync-periods', DAILY_FILES);
    expect(result).toEqual({ filesDownloaded: 2, rowsProcessed: 42 });
    expect(seen).toEqual([
      0,
      { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: 2, filesDone: 0, bytesTotal: 0, bytesDone: 0, message: '' },
      expect.objectContaining({ status: 'syncing', progress: 0.5, filesDone: 1 }),
      { status: 'syncing', phase: 'repartitioning', progress: 0.25, filesTotal: 2, filesDone: 1, bytesTotal: 400, bytesDone: 100, message: 'Completed 100 B' },
      { filesDownloaded: 0, rowsProcessed: 0 },
    ]);
    expect(h.sync.syncPeriods).toHaveBeenCalledTimes(1);
    const options = h.sync.syncPeriods.mock.calls[0]?.[0];
    expect(options).toMatchObject({ bucketPath: 's3://test-cur-bucket/daily/', providerName: AWS, tier: 'daily', syncKey: `${AWS}:daily`, dataDir: h.ws.dataDir });

    const status = await h.ipc.invoke('sync:status');
    expect(at(status, 'status')).toBe('completed');
    expect(at(status, 'filesDownloaded')).toBe(2);
    const stamps: unknown = JSON.parse(await readFile(join(h.ws.dataDir, AWS, 'meta', 'sync-timestamps.json'), 'utf-8'));
    expect(typeof at(stamps, 'daily')).toBe('string');
    expect(maintain).toHaveBeenCalledWith(['2026-02']);
    expect(recompute).toHaveBeenCalledTimes(1);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('refreshes caches only for hourly / non-first-provider syncs, and nothing when no file changed', async () => {
    const h = await syncApp('multi');
    const { maintain, recompute, warmup } = stubMaintenance(h);
    h.sync.syncPeriods.mockResolvedValue({ filesDownloaded: 1, rowsProcessed: 1 });

    await h.ipc.invoke('data:sync-periods', DAILY_FILES, 'hourly');
    expect(h.sync.syncPeriods.mock.calls[0]?.[0]).toMatchObject({ tier: 'hourly', bucketPath: 's3://test-cur-bucket/hourly/' });
    expect(warmup).toHaveBeenCalledTimes(1);

    await h.ipc.invoke('data:sync-periods', DAILY_FILES, `${FIXTURE_GCP_PROVIDER}:daily`);
    expect(h.sync.syncPeriods.mock.calls[1]?.[0]).toMatchObject({ providerName: FIXTURE_GCP_PROVIDER, auth: { kind: 'gcp' } });
    expect(warmup).toHaveBeenCalledTimes(2);
    expect(recompute).toHaveBeenCalledTimes(1);

    h.sync.syncPeriods.mockResolvedValue({ filesDownloaded: 0, rowsProcessed: 0 });
    await h.ipc.invoke('data:sync-periods', DAILY_FILES);
    expect(maintain).not.toHaveBeenCalled();
    expect(warmup).toHaveBeenCalledTimes(2);
  });

  it('still completes when the cosmetic timestamp cannot be written', async () => {
    const h = await syncApp('single', 'none');
    // A file where the provider directory belongs: the meta/ write fails.
    await writeFile(join(h.ws.dataDir, AWS), 'not a directory');
    h.sync.syncPeriods.mockResolvedValueOnce({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(await h.ipc.invoke('data:sync-periods', DAILY_FILES)).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(at(await h.ipc.invoke('sync:status'), 'status')).toBe('completed');
  });

  it('treats the client\'s duplicate-start rejection as a no-op that leaves the live status alone', async () => {
    const h = await syncApp();
    h.sync.syncPeriods.mockRejectedValueOnce(new Error(SYNC_ALREADY_RUNNING));
    expect(await h.ipc.invoke('data:sync-periods', DAILY_FILES)).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(at(await h.ipc.invoke('sync:status'), 'status')).toBe('syncing');
  });

  it('a user cancel returns the tier to idle (cancel-sync targets the provider/tier key)', async () => {
    const h = await syncApp();
    h.sync.syncPeriods.mockImplementationOnce(async () => {
      await h.ipc.invoke('data:cancel-sync');
      throw new Error('Download cancelled');
    });
    expect(await h.ipc.invoke('data:sync-periods', DAILY_FILES)).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(h.sync.cancelSync).toHaveBeenCalledWith(`${AWS}:daily`);
    expect(await h.ipc.invoke('sync:status')).toEqual({ status: 'idle', lastSync: null });
  });

  it('records a failure with the actionable sign-in message', async () => {
    const h = await syncApp();
    h.sync.syncPeriods.mockRejectedValueOnce(credentialError());
    await expect(h.ipc.invoke('data:sync-periods', DAILY_FILES)).rejects.toThrow('AWS credentials expired for profile "test-profile"');
    const status = await h.ipc.invoke('sync:status');
    expect(at(status, 'status')).toBe('failed');
    expect(at(status, 'error')).toBeInstanceOf(Error);

    h.sync.syncPeriods.mockRejectedValueOnce('a non-Error rejection');
    await expect(h.ipc.invoke('data:sync-periods', DAILY_FILES)).rejects.toThrow('a non-Error rejection');
  });
});

describe('data:cancel-sync, data:open-folder, data:account-mapping', () => {
  it('cancel is a no-op with nothing configured, and otherwise cancels by key', async () => {
    const none = await syncApp('none', 'none');
    await none.ipc.invoke('data:cancel-sync');
    expect(none.sync.cancelSync).not.toHaveBeenCalled();

    const h = await syncApp();
    await h.ipc.invoke('data:cancel-sync', 'hourly');
    expect(h.sync.cancelSync).toHaveBeenCalledWith(`${AWS}:hourly`);
  });

  it('opens (creating if needed) the data folder', async () => {
    const h = await syncApp('single', 'none', undefined);
    await h.ipc.invoke('data:open-folder');
    expect(shell.openPath).toHaveBeenCalledWith(h.ws.dataDir);
  });

  it('reads the legacy accounts CSV when present', async () => {
    const h = await syncApp();
    expect(await h.ipc.invoke('data:account-mapping')).toEqual({ status: 'missing' });
    const raw = join(h.ws.stateDir, 'raw');
    await mkdir(raw);
    expect(await h.ipc.invoke('data:account-mapping')).toEqual({ status: 'missing' });
    await writeFile(join(raw, 'AWS-Accounts.csv'), '');
    expect(await h.ipc.invoke('data:account-mapping')).toEqual({ status: 'missing' });
    await writeFile(join(raw, 'AWS-Accounts.csv'), [
      'Account ID,Parent,Org path,Email,Name,State',
      '"111111111111","r-1","/Root/Payments","pay@example.com","Payments Prod","ACTIVE"',
      ',r-1,/Root,,Orphan,ACTIVE',
      '222222222222,r-1,/Root/Data',
      '333333333333,r-1',
      '',
    ].join('\n'));
    const mapping = await h.ipc.invoke('data:account-mapping');
    expect(mapping).toEqual({
      status: 'found',
      path: join(raw, 'AWS-Accounts.csv'),
      accounts: [
        { accountId: '111111111111', name: 'Payments Prod', orgPath: '/Root/Payments', email: 'pay@example.com', state: 'ACTIVE' },
        { accountId: '222222222222', name: '', orgPath: '/Root/Data', email: '', state: '' },
        { accountId: '333333333333', name: '', orgPath: '', email: '', state: '' },
      ],
    });
  });
});

describe('CLI sign-in launchers', () => {
  function launched(): ChildProcess {
    const child = new ChildProcess();
    vi.mocked(spawn).mockReturnValueOnce(child);
    return child;
  }

  it('data:sso-login reports a missing AWS CLI', async () => {
    const h = await syncApp();
    await expect(h.ipc.invoke('data:sso-login', 'p')).rejects.toThrow('AWS_CLI_NOT_FOUND');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('data:sso-login spawns the trusted aws binary, resolves on spawn, and syncs after a clean exit', async () => {
    const h = await syncApp();
    vi.mocked(findAwsCli).mockReturnValue('/usr/local/bin/aws');
    const child = launched();
    const pending = h.ipc.invoke('data:sso-login', 'billing');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalled(); });
    expect(spawn).toHaveBeenCalledWith('/usr/local/bin/aws', ['sso', 'login', '--profile', 'billing'], { stdio: 'ignore', detached: true });
    child.emit('spawn');
    await expect(pending).resolves.toBeUndefined();
    child.emit('exit', 1);
    expect(triggerAutoSyncNow).not.toHaveBeenCalled();
    child.emit('exit', 0);
    expect(triggerAutoSyncNow).toHaveBeenCalledTimes(1);
  });

  it('data:sso-login maps ENOENT to the missing-CLI marker and passes other spawn errors through', async () => {
    const h = await syncApp();
    vi.mocked(findAwsCli).mockReturnValue('/usr/local/bin/aws');
    const gone = launched();
    const missing = h.ipc.invoke('data:sso-login', 'p');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(1); });
    gone.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(missing).rejects.toThrow('AWS_CLI_NOT_FOUND');

    const denied = launched();
    const eacces = h.ipc.invoke('data:sso-login', 'p');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2); });
    denied.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
    await expect(eacces).rejects.toThrow('spawn EACCES');
  });

  it('data:gcloud-login reports a missing gcloud CLI', async () => {
    const h = await syncApp();
    await expect(h.ipc.invoke('data:gcloud-login', 'cli')).rejects.toThrow('GCLOUD_CLI_NOT_FOUND');
  });

  it('data:gcloud-login runs the CLI sign-in for mode "cli"', async () => {
    const h = await syncApp();
    vi.mocked(findGcloudCli).mockReturnValue('/opt/google-cloud-sdk/bin/gcloud');
    const child = launched();
    const pending = h.ipc.invoke('data:gcloud-login', 'cli');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalled(); });
    const [command, args, options] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(String(command)).toContain('gcloud');
    expect(args).toEqual(expect.arrayContaining(['auth', 'login']));
    expect(args).not.toContain('application-default');
    expect(options).toMatchObject({ stdio: 'ignore', detached: true });
    expect(at(options, 'env', 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT')).toBeUndefined();
    child.emit('spawn');
    await expect(pending).resolves.toBeUndefined();
    child.emit('exit', 2);
    expect(triggerAutoSyncNow).not.toHaveBeenCalled();
    child.emit('exit', 0);
    expect(triggerAutoSyncNow).toHaveBeenCalledTimes(1);
  });

  it('data:gcloud-login defaults to a plain ADC sign-in that blanks a configured impersonation', async () => {
    const h = await syncApp('multi');
    // No ADC file on this "machine": nothing to keep.
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', join(h.ws.root, 'no-adc.json'));
    vi.mocked(findGcloudCli).mockReturnValue('/opt/google-cloud-sdk/bin/gcloud');
    const child = launched();
    const pending = h.ipc.invoke('data:gcloud-login', 'something-else');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalled(); });
    const [, args, options] = vi.mocked(spawn).mock.calls[0] ?? [];
    expect(args).toEqual(expect.arrayContaining(['auth', 'application-default', 'login']));
    expect(at(options, 'env', 'CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT')).toBe('');
    child.emit('spawn');
    await pending;

    const failing = launched();
    const failed = h.ipc.invoke('data:gcloud-login');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(2); });
    failing.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
    await expect(failed).rejects.toThrow('GCLOUD_CLI_NOT_FOUND');

    const broken = launched();
    const other = h.ipc.invoke('data:gcloud-login', 'adc');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalledTimes(3); });
    broken.emit('error', new Error('spawn EPERM'));
    await expect(other).rejects.toThrow('spawn EPERM');
  });

  it('data:gcloud-login still signs in when the config cannot be loaded, or PATH is unset', async () => {
    const h = await syncApp('none', 'none');
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', join(h.ws.root, 'no-adc.json'));
    vi.stubEnv('PATH', undefined);
    vi.mocked(findGcloudCli).mockReturnValue('/opt/google-cloud-sdk/bin/gcloud');
    const child = launched();
    const pending = h.ipc.invoke('data:gcloud-login', 'adc');
    await vi.waitFor(() => { expect(spawn).toHaveBeenCalled(); });
    expect(vi.mocked(spawn).mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['auth', 'application-default', 'login']));
    child.emit('spawn');
    await expect(pending).resolves.toBeUndefined();
  });
});
