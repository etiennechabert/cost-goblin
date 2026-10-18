import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getDataInventory } from '@costgoblin/core';
import type { DataInventory } from '@costgoblin/core';
import { startAutoSync, stopAutoSync, type AutoSyncDeps } from '../main/auto-sync.js';
import { registerAutoSyncHandlers } from '../main/handlers/auto-sync.js';
import { SYNC_ALREADY_RUNNING } from '../main/sync-client.js';
import { recordSyncLog } from '../main/sync-log.js';
import {
  FIXTURE_AWS_PROVIDER,
  FIXTURE_GCP_PROVIDER,
  FIXTURE_NOW_MS,
  createHarness,
  type FixtureConfigSet,
  type Harness,
} from './helpers/ipc-harness.js';

/** The auto-sync / auto-prune IPC surface and — through the scheduler deps it
 *  hands `startAutoSync` — the provider-aware inventory, sync, local-period
 *  and prune callbacks the scheduler drives. The scheduler's timers are
 *  replaced by a recorder; its preference files and everything below the
 *  deps are real. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('@costgoblin/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@costgoblin/core')>();
  return { ...actual, getDataInventory: vi.fn() };
});
vi.mock('../main/auto-sync.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../main/auto-sync.js')>();
  return { ...actual, startAutoSync: vi.fn(), stopAutoSync: vi.fn() };
});

const AWS = FIXTURE_AWS_PROVIDER;
const GCP = FIXTURE_GCP_PROVIDER;
const harnesses: Harness[] = [];

beforeEach(() => {
  vi.mocked(startAutoSync).mockReset();
  vi.mocked(stopAutoSync).mockReset();
  vi.mocked(getDataInventory).mockReset();
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

const prefsFile = (h: Harness): string => join(h.ws.stateDir, 'app-preferences.json');

/** Register with the given saved preferences, and wait for the launch-time
 *  scheduler refresh to have run. */
async function autoSyncApp(config: FixtureConfigSet = 'multi', prefs?: Record<string, unknown>): Promise<Harness> {
  const h = await createHarness({ config, data: 'synthetic' });
  harnesses.push(h);
  if (prefs !== undefined) await writeFile(prefsFile(h), JSON.stringify(prefs));
  registerAutoSyncHandlers(h.app);
  await vi.waitFor(() => {
    expect(vi.mocked(startAutoSync).mock.calls.length + vi.mocked(stopAutoSync).mock.calls.length).toBeGreaterThan(0);
  });
  vi.mocked(startAutoSync).mockClear();
  vi.mocked(stopAutoSync).mockClear();
  return h;
}

/** The deps the scheduler was (re)started with on the latest call. */
async function schedulerDeps(h: Harness): Promise<AutoSyncDeps> {
  await h.ipc.invoke('auto-sync:set-enabled', true);
  const deps = vi.mocked(startAutoSync).mock.calls.at(-1)?.[0];
  if (deps === undefined) throw new Error('the scheduler was not started');
  return deps;
}

function stubMaintenance(h: Harness) {
  return {
    maintain: vi.spyOn(h.app, 'maintainRollup').mockImplementation(() => undefined),
    warmup: vi.spyOn(h.app, 'warmupBase').mockImplementation(() => undefined),
  };
}

function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

const FILES = [
  { key: 'focus/daily/data/billing_period=2026-02/part-0.parquet', contentHash: 'e1', size: 10 },
  { key: 'focus/daily/data/billing_period=2026-01/part-0.parquet', contentHash: 'e2', size: 10 },
];

const INVENTORY: DataInventory = {
  periods: [{ period: '2026-02', files: FILES, totalSize: 20, localStatus: 'stale' }],
  totalRemoteSize: 20,
  totalLocalPeriods: 2,
  totalRemotePeriods: 1,
  lastSync: null,
  local: { periods: ['2026-01', '2026-02'], diskBytes: 1, oldestPeriod: '2026-01', newestPeriod: '2026-02' },
};

describe('scheduler start / stop', () => {
  it('starts on launch when auto-sync or auto-prune was left on, at the saved interval', async () => {
    const h = await createHarness({ config: 'multi' });
    harnesses.push(h);
    await writeFile(prefsFile(h), JSON.stringify({ autoPrune: true, autoSyncIntervalMinutes: 180 }));
    registerAutoSyncHandlers(h.app);
    await vi.waitFor(() => { expect(startAutoSync).toHaveBeenCalledWith(expect.any(Object), 180); });
    expect(stopAutoSync).not.toHaveBeenCalled();
  });

  it('stays stopped on launch with both off, and survives a scheduler that fails to start', async () => {
    const off = await createHarness({ config: 'multi' });
    harnesses.push(off);
    registerAutoSyncHandlers(off.app);
    await vi.waitFor(() => { expect(stopAutoSync).toHaveBeenCalledTimes(1); });
    expect(startAutoSync).not.toHaveBeenCalled();

    const broken = await createHarness({ config: 'multi' });
    harnesses.push(broken);
    await writeFile(prefsFile(broken), JSON.stringify({ autoSync: true }));
    vi.mocked(startAutoSync).mockImplementationOnce(() => { throw new Error('timer failure'); });
    expect(() => { registerAutoSyncHandlers(broken.app); }).not.toThrow();
    await vi.waitFor(() => { expect(startAutoSync).toHaveBeenCalledTimes(1); });
  });

  it('persists each toggle and restarts or stops the shared scheduler accordingly', async () => {
    const h = await autoSyncApp();
    expect(await h.ipc.invoke('auto-sync:get-enabled')).toBe(false);
    expect(await h.ipc.invoke('auto-prune:get-enabled')).toBe(false);
    expect(await h.ipc.invoke('auto-sync:get-interval')).toBe(24 * 60);

    await h.ipc.invoke('auto-sync:set-enabled', true);
    expect(startAutoSync).toHaveBeenLastCalledWith(expect.any(Object), 24 * 60);
    await h.ipc.invoke('auto-prune:set-enabled', true);
    await h.ipc.invoke('auto-sync:set-enabled', false);
    // Auto-prune alone still needs the scheduler.
    expect(stopAutoSync).not.toHaveBeenCalled();
    expect(startAutoSync).toHaveBeenCalledTimes(3);
    await h.ipc.invoke('auto-prune:set-enabled', false);
    expect(stopAutoSync).toHaveBeenCalledTimes(1);

    await h.ipc.invoke('auto-sync:set-interval', 5);
    expect(await h.ipc.invoke('auto-sync:get-interval')).toBe(60);
    expect(stopAutoSync).toHaveBeenCalledTimes(2);
    expect(JSON.parse(await readFile(prefsFile(h), 'utf-8'))).toMatchObject({ autoSync: false, autoPrune: false, autoSyncIntervalMinutes: 60 });
    expect(await h.ipc.invoke('auto-sync:get-status')).toEqual({ state: 'disabled' });
  });
});

describe('scheduler deps', () => {
  it('carry the app clock, the sync log and every configured provider', async () => {
    const h = await autoSyncApp();
    const deps = await schedulerDeps(h);
    expect(deps.now()).toBe(FIXTURE_NOW_MS);
    expect(deps.onLog).toBe(recordSyncLog);
    expect(await deps.getPrefsPath()).toBe(prefsFile(h));
    expect((await deps.getConfig()).providers.map(p => p.name)).toEqual([AWS, GCP]);
  });

  it('getInventory lists a provider\'s tier and keeps only what the scheduler needs', async () => {
    const h = await autoSyncApp();
    const deps = await schedulerDeps(h);
    vi.mocked(getDataInventory).mockResolvedValue(INVENTORY);
    expect(await deps.getInventory(AWS, 'daily')).toEqual({ periods: [{ period: '2026-02', localStatus: 'stale', files: FILES }] });
    await deps.getInventory(AWS, 'hourly');
    await deps.getInventory(AWS, 'cost-optimization');
    await deps.getInventory(GCP, 'weird-tier');
    expect(vi.mocked(getDataInventory).mock.calls.map(c => [c[0], c[4]])).toEqual([
      ['s3://test-cur-bucket/daily/', 'daily'],
      ['s3://test-cur-bucket/hourly/', 'hourly'],
      ['s3://test-cur-bucket/cost-optimization/', 'cost-optimization'],
      ['gs://test-focus-export/focus/daily/', 'daily'],
    ]);
  });

  it('getInventory rewrites a credential failure, passes others through, and refuses an unknown provider', async () => {
    const h = await autoSyncApp();
    const deps = await schedulerDeps(h);
    vi.mocked(getDataInventory).mockRejectedValueOnce(new Error('Could not load credentials from any providers'));
    await expect(deps.getInventory(AWS, 'daily')).rejects.toThrow('AWS credentials expired for profile "test-profile". Run: aws sso login --profile test-profile');
    vi.mocked(getDataInventory).mockRejectedValueOnce(new Error('Could not load the default credentials'));
    await expect(deps.getInventory(GCP, 'daily')).rejects.toThrow('GCP credentials are missing or expired');
    const network = new Error('getaddrinfo ENOTFOUND s3.amazonaws.com');
    vi.mocked(getDataInventory).mockRejectedValueOnce(network);
    await expect(deps.getInventory(AWS, 'daily')).rejects.toBe(network);
    await expect(deps.getInventory('gone', 'daily')).rejects.toThrow('Unknown provider "gone"');
  });

  it('syncPeriods tracks progress and completion, then re-rolls the first provider\'s daily months', async () => {
    const h = await autoSyncApp();
    const { maintain, warmup } = stubMaintenance(h);
    const deps = await schedulerDeps(h);
    const seen: unknown[] = [];
    h.sync.syncPeriods.mockImplementationOnce((options) => {
      options.onProgress?.({ phase: 'downloading', filesTotal: 0, filesDone: 0 });
      seen.push(h.app.state.syncStatuses[`${AWS}:daily`]);
      options.onProgress?.({ phase: 'downloading', filesTotal: 4, filesDone: 1 });
      seen.push(h.app.state.syncStatuses[`${AWS}:daily`]);
      options.onProgress?.({ phase: 'repartitioning', filesTotal: 4, filesDone: 2, bytesTotal: 100, bytesDone: 75, message: 'Completed' });
      seen.push(h.app.state.syncStatuses[`${AWS}:daily`]);
      return Promise.resolve({ filesDownloaded: 2, rowsProcessed: 5 });
    });
    expect(await deps.syncPeriods(AWS, FILES, 'daily')).toEqual({ filesDownloaded: 2, rowsProcessed: 5 });
    expect(seen).toEqual([
      expect.objectContaining({ status: 'syncing', progress: 0, phase: 'downloading', message: '' }),
      expect.objectContaining({ status: 'syncing', progress: 0.25 }),
      { status: 'syncing', phase: 'repartitioning', progress: 0.75, filesTotal: 4, filesDone: 2, bytesTotal: 100, bytesDone: 75, message: 'Completed' },
    ]);
    expect(h.sync.syncPeriods.mock.calls[0]?.[0]).toMatchObject({ providerName: AWS, tier: 'daily', syncKey: `${AWS}:daily`, bucketPath: 's3://test-cur-bucket/daily/' });
    expect(h.app.state.syncStatuses[`${AWS}:daily`]).toMatchObject({ status: 'completed', filesDownloaded: 2 });
    expect(await exists(join(h.ws.dataDir, AWS, 'meta', 'sync-timestamps.json'))).toBe(true);
    expect(maintain).toHaveBeenCalledWith(['2026-02', '2026-01']);
    expect(warmup).not.toHaveBeenCalled();
  });

  it('syncPeriods only refreshes caches for other tiers and providers, and nothing when no file changed', async () => {
    const h = await autoSyncApp();
    const { maintain, warmup } = stubMaintenance(h);
    const deps = await schedulerDeps(h);
    h.sync.syncPeriods.mockResolvedValue({ filesDownloaded: 1, rowsProcessed: 1 });
    await deps.syncPeriods(AWS, FILES, 'hourly');
    await deps.syncPeriods(GCP, FILES, 'daily');
    expect(warmup).toHaveBeenCalledTimes(2);
    h.sync.syncPeriods.mockResolvedValue({ filesDownloaded: 0, rowsProcessed: 0 });
    await deps.syncPeriods(AWS, FILES, 'daily');
    expect(warmup).toHaveBeenCalledTimes(2);
    expect(maintain).not.toHaveBeenCalled();
  });

  it('syncPeriods never races a sync already running for the same provider and tier', async () => {
    const h = await autoSyncApp();
    const deps = await schedulerDeps(h);
    h.app.state.syncStatuses[`${AWS}:daily`] = { status: 'syncing', phase: 'downloading', progress: 0.1, filesTotal: 1, filesDone: 0, bytesTotal: 0, bytesDone: 0, message: '' };
    expect(await deps.syncPeriods(AWS, FILES, 'daily')).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(h.sync.syncPeriods).not.toHaveBeenCalled();

    h.app.state.syncStatuses = {};
    h.sync.syncPeriods.mockRejectedValueOnce(new Error(SYNC_ALREADY_RUNNING));
    expect(await deps.syncPeriods(AWS, FILES, 'daily')).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(h.app.state.syncStatuses[`${AWS}:daily`]?.status).toBe('syncing');
  });

  it('syncPeriods returns a cancelled tier to idle and marks a failure with the actionable message', async () => {
    const h = await autoSyncApp();
    const deps = await schedulerDeps(h);
    h.sync.syncPeriods.mockRejectedValueOnce(new Error('Download cancelled'));
    expect(await deps.syncPeriods(AWS, FILES, 'daily')).toEqual({ filesDownloaded: 0, rowsProcessed: 0 });
    expect(h.app.state.syncStatuses[`${AWS}:daily`]).toEqual({ status: 'idle', lastSync: null });

    h.sync.syncPeriods.mockRejectedValueOnce(new Error('aws s3 sync failed: download failed: s3://bucket/x'));
    await expect(deps.syncPeriods(AWS, FILES, 'daily')).rejects.toThrow(/^Download from S3 failed/);
    expect(h.app.state.syncStatuses[`${AWS}:daily`]?.status).toBe('failed');
  });

  it('getLocalPeriods reads the provider\'s on-disk months for a tier', async () => {
    const h = await autoSyncApp();
    const deps = await schedulerDeps(h);
    expect(await deps.getLocalPeriods(AWS, 'daily')).toEqual(['2026-01', '2026-02']);
    expect(await deps.getLocalPeriods(AWS, 'hourly')).toEqual(['2026-02']);
    expect(await deps.getLocalPeriods(GCP, 'hourly')).toEqual([]);
  });

  it('deletePeriods prunes and cascades only the first provider\'s daily months into the rollup', async () => {
    const h = await autoSyncApp();
    const { maintain } = stubMaintenance(h);
    const deletePeriod = vi.spyOn(h.app.rollupStore, 'deletePeriod');
    const deps = await schedulerDeps(h);
    const raw = (provider: string, dir: string): string => join(h.ws.dataDir, provider, 'raw', dir);

    await deps.deletePeriods(AWS, ['2026-01'], 'daily');
    expect(await exists(raw(AWS, 'daily-2026-01'))).toBe(false);
    expect(deletePeriod).toHaveBeenCalledWith('2026-01');

    await deps.deletePeriods(AWS, ['2026-02-10'], 'daily');
    expect(maintain).toHaveBeenCalledWith(['2026-02']);

    await deps.deletePeriods(AWS, ['2026-02'], 'hourly');
    await deps.deletePeriods(GCP, ['2026-01'], 'daily');
    expect(await exists(raw(AWS, 'hourly-2026-02'))).toBe(false);
    expect(await exists(raw(GCP, 'daily-2026-01'))).toBe(false);
    expect(deletePeriod).toHaveBeenCalledTimes(1);
    expect(maintain).toHaveBeenCalledTimes(1);
  });
});
