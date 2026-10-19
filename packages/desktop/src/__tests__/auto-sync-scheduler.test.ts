import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncLogLevel } from '@costgoblin/core';
import type { AutoSyncDeps, AutoSyncProvider } from '../main/auto-sync.js';

/** The auto-sync preference file round-trips, the scheduler's timers and
 *  out-of-band trigger, and the runOnce paths auto-sync.test.ts leaves out.
 *  The module keeps its scheduler state at module level, so each case loads a
 *  fresh copy. */

type AutoSyncModule = typeof import('../main/auto-sync.js');

async function freshModule(): Promise<AutoSyncModule> {
  vi.resetModules();
  return import('../main/auto-sync.js');
}

const PROVIDER: AutoSyncProvider = { name: 'aws-main', sync: { daily: { retentionDays: 365 } } };

type Inventory = Awaited<ReturnType<AutoSyncDeps['getInventory']>>;

function inventory(...periods: { period: string; localStatus: string }[]): Inventory {
  return { periods: periods.map(p => ({ ...p, files: [{ key: `${p.period}.parquet`, contentHash: p.period, size: 1 }] })) };
}

let dir = '';
let prefsPath = '';

function writePrefs(prefs: Record<string, unknown>): void {
  writeFileSync(prefsPath, JSON.stringify(prefs));
}

function readPrefs(): unknown {
  return JSON.parse(readFileSync(prefsPath, 'utf-8'));
}

interface Recorded {
  readonly logs: { level: SyncLogLevel; message: string }[];
  readonly synced: { provider: string; files: number; tier: string }[];
  prefsReads: number;
}

function buildDeps(overrides: Partial<AutoSyncDeps> = {}): { deps: AutoSyncDeps; recorded: Recorded } {
  const recorded: Recorded = { logs: [], synced: [], prefsReads: 0 };
  const deps: AutoSyncDeps = {
    now: () => Date.now(),
    onLog: (level, message) => { recorded.logs.push({ level, message }); },
    getPrefsPath: () => { recorded.prefsReads += 1; return Promise.resolve(prefsPath); },
    getConfig: () => Promise.resolve({ providers: [PROVIDER] }),
    getInventory: () => Promise.resolve(inventory({ period: '2999-01', localStatus: 'missing' })),
    syncPeriods: (provider, files, tier) => {
      recorded.synced.push({ provider, files: files.length, tier });
      return Promise.resolve({ filesDownloaded: files.length });
    },
    getLocalPeriods: () => Promise.resolve([]),
    deletePeriods: () => Promise.resolve(),
    ...overrides,
  };
  return { deps, recorded };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cg-auto-sync-sched-'));
  prefsPath = join(dir, 'app-preferences.json');
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('auto-sync preferences', () => {
  it('reads both toggles as off until they are written, keeping the rest of the file', async () => {
    const mod = await freshModule();
    expect(await mod.readAutoSyncEnabled(prefsPath)).toBe(false);
    expect(await mod.readAutoPruneEnabled(prefsPath)).toBe(false);

    writePrefs({ theme: 'dark' });
    await mod.writeAutoSyncEnabled(prefsPath, true);
    await mod.writeAutoPruneEnabled(prefsPath, true);

    expect(await mod.readAutoSyncEnabled(prefsPath)).toBe(true);
    expect(await mod.readAutoPruneEnabled(prefsPath)).toBe(true);
    expect(readPrefs()).toEqual({ theme: 'dark', autoSync: true, autoPrune: true });

    await mod.writeAutoSyncEnabled(prefsPath, false);
    expect(await mod.readAutoSyncEnabled(prefsPath)).toBe(false);
  });

  it('reads the default interval until one is written, and clamps what it writes to the UI range', async () => {
    const mod = await freshModule();
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(mod.DEFAULT_AUTO_SYNC_INTERVAL_MINUTES);

    await mod.writeAutoSyncIntervalMinutes(prefsPath, 90.4);
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(90);

    await mod.writeAutoSyncIntervalMinutes(prefsPath, 5);
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(mod.MIN_AUTO_SYNC_INTERVAL_MINUTES);

    await mod.writeAutoSyncIntervalMinutes(prefsPath, 10_000_000);
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(mod.MAX_AUTO_SYNC_INTERVAL_MINUTES);

    await mod.writeAutoSyncIntervalMinutes(prefsPath, Number.POSITIVE_INFINITY);
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(mod.DEFAULT_AUTO_SYNC_INTERVAL_MINUTES);
  });

  it('clamps a hand-edited interval on read and ignores one that is not a number', async () => {
    const mod = await freshModule();
    writePrefs({ autoSyncIntervalMinutes: 1 });
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(mod.MIN_AUTO_SYNC_INTERVAL_MINUTES);

    writePrefs({ autoSyncIntervalMinutes: 'hourly' });
    expect(await mod.readAutoSyncIntervalMinutes(prefsPath)).toBe(mod.DEFAULT_AUTO_SYNC_INTERVAL_MINUTES);
  });
});

describe('auto-sync runOnce', () => {
  it('re-downloads stale periods, skips current ones, and feeds the activity log', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const { deps, recorded } = buildDeps({
      getInventory: () => Promise.resolve(inventory(
        { period: '2999-01', localStatus: 'stale' },
        { period: '2999-02', localStatus: 'synced' },
      )),
    });

    await mod.runOnce(deps);

    expect(recorded.synced).toEqual([{ provider: 'aws-main', files: 1, tier: 'daily' }]);
    expect(recorded.logs.map(l => l.message)).toEqual([
      'Auto-sync: checking',
      'Auto-sync: aws-main/daily — syncing 1 periods (1 files)',
      'Auto-sync: aws-main/daily — synced 1 files',
    ]);
    expect(recorded.logs.every(l => l.level === 'info')).toBe(true);
  });

  it('reports nothing to sync when every in-retention period is already local', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const { deps, recorded } = buildDeps({
      // Missing, but older than the 365-day retention: not worth downloading.
      getInventory: () => Promise.resolve(inventory({ period: '2001-01', localStatus: 'missing' }, { period: '2999-01', localStatus: 'synced' })),
    });

    await mod.runOnce(deps);

    expect(recorded.synced).toEqual([]);
    expect(recorded.logs.at(-1)).toEqual({ level: 'info', message: 'Auto-sync: aws-main/daily — nothing to sync' });
    expect(mod.getAutoSyncStatus().state).toBe('idle');
  });

  it('records a download that fails with a non-Error by its text', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const { deps, recorded } = buildDeps({
      syncPeriods: vi.fn<AutoSyncDeps['syncPeriods']>().mockRejectedValue('bucket gone'),
    });

    await mod.runOnce(deps);

    expect(mod.getAutoSyncStatus()).toMatchObject({
      state: 'error',
      message: 'bucket gone',
      providerErrors: [{ provider: 'aws-main', message: 'bucket gone' }],
    });
    expect(recorded.logs.at(-1)).toEqual({ level: 'warn', message: 'Auto-sync: aws-main/daily — sync failed: bucket gone' });
  });

  it('keeps pruning past a delete that fails', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: false, autoPrune: true });
    const deleted: string[] = [];
    const { deps, recorded } = buildDeps({
      getConfig: () => Promise.resolve({ providers: [PROVIDER, { name: 'aws-b', sync: { daily: { retentionDays: 30 } } }] }),
      getLocalPeriods: () => Promise.resolve(['2000-01']),
      deletePeriods: (provider) => {
        if (provider === 'aws-main') return Promise.reject(new Error('EBUSY: resource busy'));
        deleted.push(provider);
        return Promise.resolve();
      },
    });

    await mod.runOnce(deps);

    expect(deleted).toEqual(['aws-b']);
    expect(recorded.logs).toContainEqual({ level: 'warn', message: 'Auto-prune: aws-main/daily — delete failed: EBUSY: resource busy' });
    expect(mod.getAutoSyncStatus().state).toBe('idle');
  });

  it('flips to error when the pass itself fails before reaching any provider', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const { deps } = buildDeps({ getConfig: vi.fn<AutoSyncDeps['getConfig']>().mockRejectedValue(new Error('costgoblin.yaml is invalid')) });

    await mod.runOnce(deps);

    const status = mod.getAutoSyncStatus();
    expect(status).toMatchObject({ state: 'error', message: 'costgoblin.yaml is invalid' });
    expect(status.state === 'error' && status.providerErrors === undefined).toBe(true);

    // The failed pass released the run lock: the next one goes ahead.
    const { deps: healthy, recorded } = buildDeps();
    await mod.runOnce(healthy);
    expect(recorded.synced).toHaveLength(1);
  });

  it('joins the pass already running instead of starting another', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { deps, recorded } = buildDeps({ getConfig: async () => { await gate; return { providers: [PROVIDER] }; } });

    const first = mod.runOnce(deps);
    await vi.waitFor(() => { expect(mod.getAutoSyncStatus().state).toBe('checking'); });
    const second = mod.runOnce(deps);
    expect(second).toBe(first);
    release();
    await Promise.all([first, second]);

    expect(recorded.prefsReads).toBe(1);
    expect(recorded.synced).toHaveLength(1);
  });
});

describe('auto-sync scheduler', () => {
  beforeEach(() => {
    // Date too: the scheduler counts each interval on the wall clock, so
    // advancing only the timers would never make a pass fall due.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });

  it('runs a first pass five seconds after start, then once per interval until stopped', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const { deps, recorded } = buildDeps();

    mod.startAutoSync(deps, 90);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(recorded.prefsReads).toBe(0);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => { expect(recorded.synced).toHaveLength(1); });
    const status = mod.getAutoSyncStatus();
    if (status.state !== 'idle' || status.nextRun === null || status.lastRun === null) throw new Error('expected an idle status with a next run');
    expect(Date.parse(status.nextRun) - Date.parse(status.lastRun)).toBeCloseTo(90 * 60_000, -3);

    await vi.advanceTimersByTimeAsync(90 * 60_000);
    await vi.waitFor(() => { expect(recorded.synced).toHaveLength(2); });

    mod.stopAutoSync();
    expect(mod.getAutoSyncStatus()).toEqual({ state: 'disabled' });
    await vi.advanceTimersByTimeAsync(3 * 90 * 60_000);
    expect(recorded.synced).toHaveLength(2);
  });

  it('never schedules more often than hourly', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const { deps, recorded } = buildDeps();

    mod.startAutoSync(deps, 5);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => { expect(recorded.synced).toHaveLength(1); });

    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(recorded.prefsReads).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => { expect(recorded.synced).toHaveLength(2); });
    mod.stopAutoSync();
  });

  it('restarting replaces the pending first pass instead of adding a second one', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    const first = buildDeps();
    const second = buildDeps();

    mod.startAutoSync(first.deps, 60);
    mod.startAutoSync(second.deps, 60);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => { expect(second.recorded.synced).toHaveLength(1); });

    expect(first.recorded.prefsReads).toBe(0);
    mod.stopAutoSync();
  });
});

describe('auto-sync out-of-band trigger', () => {
  it('does nothing before the scheduler has ever started', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });

    mod.triggerAutoSyncNow();

    expect(mod.getAutoSyncStatus()).toEqual({ state: 'disabled' });
  });

  it('runs a pass at once with the scheduler\'s deps, but not on top of a running one', async () => {
    const mod = await freshModule();
    writePrefs({ autoSync: true, autoPrune: false });
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { deps, recorded } = buildDeps({ getConfig: async () => { await gate; return { providers: [PROVIDER] }; } });
    mod.startAutoSync(deps, 60);

    mod.triggerAutoSyncNow();
    await vi.waitFor(() => { expect(mod.getAutoSyncStatus().state).toBe('checking'); });
    mod.triggerAutoSyncNow();
    release();
    await vi.waitFor(() => { expect(mod.getAutoSyncStatus().state).toBe('idle'); });

    expect(recorded.prefsReads).toBe(1);
    expect(recorded.synced).toHaveLength(1);
    mod.stopAutoSync();
  });
});
