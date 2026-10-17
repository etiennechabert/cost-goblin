import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSyncStateError } from '@costgoblin/core';
import {
  runOnce,
  getAutoSyncStatus,
  startAutoSync,
  stopAutoSync,
  triggerAutoSyncNow,
  MAX_AUTO_SYNC_INTERVAL_MINUTES,
  type AutoSyncDeps,
  type AutoSyncProvider,
} from '../main/auto-sync.js';
import { parseSyncId, resolveProvider, resolveSyncId, syncStatusKey } from '../main/sync-id.js';

describe('sync-id (composite syncId convention)', () => {
  const providers = [
    { name: 'aws-a' },
    { name: 'aws-b' },
  ];

  it('parses legacy tier-only ids against no provider segment', () => {
    expect(parseSyncId('default')).toEqual({ providerName: null, tier: 'daily' });
    expect(parseSyncId('daily')).toEqual({ providerName: null, tier: 'daily' });
    expect(parseSyncId('hourly')).toEqual({ providerName: null, tier: 'hourly' });
    expect(parseSyncId('cost-optimization')).toEqual({ providerName: null, tier: 'cost-optimization' });
  });

  it('splits composite ids on the LAST colon (provider names may contain colons)', () => {
    expect(parseSyncId('aws-a:hourly')).toEqual({ providerName: 'aws-a', tier: 'hourly' });
    expect(parseSyncId('aws-a:cost-optimization')).toEqual({ providerName: 'aws-a', tier: 'cost-optimization' });
    expect(parseSyncId('my:provider:hourly')).toEqual({ providerName: 'my:provider', tier: 'hourly' });
  });

  it('maps an unrecognized tier segment to daily (legacy mapping)', () => {
    expect(parseSyncId('aws-a:default').tier).toBe('daily');
    expect(parseSyncId('bogus').tier).toBe('daily');
  });

  it('resolveSyncId resolves legacy ids to the FIRST provider and normalizes the key', () => {
    const resolved = resolveSyncId('default', providers);
    expect(resolved.provider.name).toBe('aws-a');
    expect(resolved.tier).toBe('daily');
    expect(resolved.key).toBe('aws-a:daily');
    expect(resolveSyncId('hourly', providers).key).toBe('aws-a:hourly');
  });

  it('resolveSyncId resolves a composite id by exact provider name', () => {
    const resolved = resolveSyncId('aws-b:hourly', providers);
    expect(resolved.provider.name).toBe('aws-b');
    expect(resolved.key).toBe('aws-b:hourly');
    // Round-trip: a normalized key resolves back to the same key.
    expect(resolveSyncId(resolved.key, providers).key).toBe(resolved.key);
  });

  it('throws on an unknown provider segment and on an empty provider list', () => {
    expect(() => resolveSyncId('nope:daily', providers)).toThrow('Unknown provider "nope"');
    expect(() => resolveSyncId('default', [])).toThrow('No provider configured');
  });

  it('resolveProvider defaults to the first provider and looks up by name', () => {
    expect(resolveProvider(providers).name).toBe('aws-a');
    expect(resolveProvider(providers, 'aws-b').name).toBe('aws-b');
    expect(() => resolveProvider(providers, 'gone')).toThrow('Unknown provider "gone"');
    expect(() => resolveProvider([])).toThrow('No provider configured');
  });

  it('syncStatusKey builds the normalized composite key', () => {
    expect(syncStatusKey('aws-a', 'cost-optimization')).toBe('aws-a:cost-optimization');
  });
});

describe('auto-sync runOnce (multi-provider orchestration)', () => {
  let base: string;
  let prefsFile: string;

  const providerA: AutoSyncProvider = { name: 'aws-a', sync: { daily: { retentionDays: 365 } } };
  const providerB: AutoSyncProvider = { name: 'aws-b', sync: { daily: { retentionDays: 365 }, hourly: { retentionDays: 30 } } };

  const CREDENTIAL_ERROR = 'The SSO session associated with this profile has expired';

  interface Calls {
    inventory: { provider: string; tier: string }[];
    sync: { provider: string; tier: string; files: number }[];
    localReads: { provider: string; tier: string }[];
    deletes: { provider: string; periods: readonly string[]; tier: string }[];
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cg-auto-sync-'));
    prefsFile = join(base, 'app-preferences.json');
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function writePrefs(prefs: { autoSync: boolean; autoPrune: boolean }): void {
    writeFileSync(prefsFile, JSON.stringify(prefs));
  }

  function missingPeriodInventory(): { periods: { period: string; localStatus: string; files: { key: string; contentHash: string; size: number }[] }[] } {
    return {
      periods: [{
        period: '2999-01',
        localStatus: 'missing',
        files: [
          { key: 'f1.parquet', contentHash: 'h1', size: 10 },
          { key: 'f2.parquet', contentHash: 'h2', size: 20 },
        ],
      }],
    };
  }

  function buildDeps(overrides: Partial<AutoSyncDeps>, calls: Calls): AutoSyncDeps {
    return {
      now: () => Date.now(),
      getPrefsPath: () => Promise.resolve(prefsFile),
      getConfig: () => Promise.resolve({ providers: [providerA, providerB] }),
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        return Promise.resolve(missingPeriodInventory());
      },
      syncPeriods: (provider, files, tier) => {
        calls.sync.push({ provider, tier, files: files.length });
        return Promise.resolve({ filesDownloaded: files.length });
      },
      getLocalPeriods: (provider, tier) => {
        calls.localReads.push({ provider, tier });
        return Promise.resolve([]);
      },
      deletePeriods: (provider, periods, tier) => {
        calls.deletes.push({ provider, periods, tier });
        return Promise.resolve();
      },
      ...overrides,
    };
  }

  function newCalls(): Calls {
    return { inventory: [], sync: [], localReads: [], deletes: [] };
  }

  it('isolates one provider\'s credential failure: the other still syncs, status ends idle with one ProviderSyncError', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const seenSyncing: { state: string; provider?: string | undefined }[] = [];
    const deps = buildDeps({
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        if (provider === 'aws-a') return Promise.reject(new Error(CREDENTIAL_ERROR));
        return Promise.resolve(missingPeriodInventory());
      },
      syncPeriods: (provider, files, tier) => {
        calls.sync.push({ provider, tier, files: files.length });
        const status = getAutoSyncStatus();
        if (status.state === 'syncing') seenSyncing.push({ state: status.state, provider: status.provider });
        return Promise.resolve({ filesDownloaded: files.length });
      },
    }, calls);

    await runOnce(deps);

    // Provider B synced despite A's failure — both its tiers, sequentially.
    expect(calls.sync).toEqual([
      { provider: 'aws-b', tier: 'daily', files: 2 },
      { provider: 'aws-b', tier: 'hourly', files: 2 },
    ]);
    // The mid-flight 'syncing' status carried the current provider name.
    expect(seenSyncing).toEqual([
      { state: 'syncing', provider: 'aws-b' },
      { state: 'syncing', provider: 'aws-b' },
    ]);

    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.providerErrors).toEqual([{ provider: 'aws-a', message: CREDENTIAL_ERROR }]);
      expect(status.lastRun).not.toBeNull();
      expect(status.nextRun).not.toBeNull();
    }
  });

  it('aborts a provider\'s remaining tiers on failure without touching the other provider', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const deps = buildDeps({
      syncPeriods: (provider, files, tier) => {
        calls.sync.push({ provider, tier, files: files.length });
        if (provider === 'aws-b' && tier === 'daily') return Promise.reject(new Error('disk full'));
        return Promise.resolve({ filesDownloaded: files.length });
      },
    }, calls);

    await runOnce(deps);

    // B's daily failure skipped B's hourly, but A (which ran first) completed.
    expect(calls.sync).toEqual([
      { provider: 'aws-a', tier: 'daily', files: 2 },
      { provider: 'aws-b', tier: 'daily', files: 2 },
    ]);
    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.providerErrors).toEqual([{ provider: 'aws-b', message: 'disk full' }]);
    }
  });

  it('flips to error (message = first failure) when EVERY provider fails', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const deps = buildDeps({
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        if (provider === 'aws-a') return Promise.reject(new Error(CREDENTIAL_ERROR));
        return Promise.resolve(missingPeriodInventory());
      },
      syncPeriods: () => Promise.reject(new Error('bucket unreachable')),
    }, calls);

    await runOnce(deps);

    const status = getAutoSyncStatus();
    expect(status.state).toBe('error');
    if (status.state === 'error') {
      expect(status.message).toBe(CREDENTIAL_ERROR);
      expect(status.providerErrors).toEqual([
        { provider: 'aws-a', message: CREDENTIAL_ERROR },
        { provider: 'aws-b', message: 'bucket unreachable' },
      ]);
    }
  });

  it('records a refused GCP impersonation as a provider error, though no sign-in fixes it', async () => {
    // The handler has already rewritten the denial (describeGcpImpersonationFailure),
    // so this is the shape the scheduler classifies. A skip here would leave
    // the provider silently unsynced every pass while the toolbar shows idle.
    const denial = "CostGoblin could not read as reader@proj.iam.gserviceaccount.com. Check that … — Details: Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).";
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const deps = buildDeps({
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        if (provider === 'aws-a') return Promise.reject(new Error(denial));
        return Promise.resolve(missingPeriodInventory());
      },
    }, calls);

    await runOnce(deps);

    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.providerErrors).toEqual([{ provider: 'aws-a', message: denial }]);
    }
  });

  it('treats a transient (non-credential) inventory failure as a skip, not a provider error', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const deps = buildDeps({
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        if (provider === 'aws-a') return Promise.reject(new Error('connect ETIMEDOUT'));
        return Promise.resolve(missingPeriodInventory());
      },
    }, calls);

    await runOnce(deps);

    // A was skipped silently; B synced; no providerErrors collected.
    expect(calls.sync.every(c => c.provider === 'aws-b')).toBe(true);
    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.providerErrors).toBeUndefined();
    }
  });

  it('records unreadable local sync state as a provider error instead of skipping the tier', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const unreadable = new LocalSyncStateError('the saved daily sync state', Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    const deps = buildDeps({
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        if (provider === 'aws-a') return Promise.reject(unreadable);
        return Promise.resolve(missingPeriodInventory());
      },
    }, calls);

    await runOnce(deps);

    // A skip would retry and skip on every pass, the tier never syncing again
    // with nothing on screen to say why.
    expect(calls.sync.every(c => c.provider === 'aws-b')).toBe(true);
    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.providerErrors).toEqual([{ provider: 'aws-a', message: unreadable.message }]);
    }
  });

  it('keeps syncing a provider\'s other tiers past one with unreadable local sync state', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const unreadable = new LocalSyncStateError('the saved daily sync state', Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }));
    const deps = buildDeps({
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        if (provider === 'aws-b' && tier === 'daily') return Promise.reject(unreadable);
        return Promise.resolve(missingPeriodInventory());
      },
    }, calls);

    await runOnce(deps);

    // Each tier has its own sidecar: B's hourly still syncs.
    expect(calls.sync.map(c => `${c.provider}/${c.tier}`)).toEqual(['aws-a/daily', 'aws-b/hourly']);
    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.providerErrors).toEqual([{ provider: 'aws-b', message: unreadable.message }]);
    }
  });

  it('auto-prune pass covers every provider x its configured tier retentions', async () => {
    writePrefs({ autoSync: false, autoPrune: true });
    const calls = newCalls();
    const currentMonth = new Date().toISOString().slice(0, 7);
    const deps = buildDeps({
      getLocalPeriods: (provider, tier) => {
        calls.localReads.push({ provider, tier });
        return Promise.resolve(['2000-01', currentMonth]);
      },
    }, calls);

    await runOnce(deps);

    // A has daily only; B has daily + hourly — same loop as manual data:prune.
    expect(calls.localReads).toEqual([
      { provider: 'aws-a', tier: 'daily' },
      { provider: 'aws-b', tier: 'daily' },
      { provider: 'aws-b', tier: 'hourly' },
    ]);
    // Only the out-of-retention period is deleted, per provider and tier.
    expect(calls.deletes).toEqual([
      { provider: 'aws-a', periods: ['2000-01'], tier: 'daily' },
      { provider: 'aws-b', periods: ['2000-01'], tier: 'daily' },
      { provider: 'aws-b', periods: ['2000-01'], tier: 'hourly' },
    ]);
    // Sync disabled → no inventory/download traffic at all.
    expect(calls.inventory).toEqual([]);
    expect(calls.sync).toEqual([]);
    expect(getAutoSyncStatus().state).toBe('idle');
  });

  // The e2e FIXTURE_NOW, months after which the real clock has moved on: the
  // retention decisions must follow the injected clock, never Date.
  const PINNED_NOW = Date.UTC(2026, 2, 2, 12);
  const FIXTURE_MONTHS = ['2025-12', '2026-01', '2026-02'];

  it('prunes against the injected clock, not the wall clock', async () => {
    writePrefs({ autoSync: false, autoPrune: true });
    const calls = newCalls();
    const deps = buildDeps({
      now: () => PINNED_NOW,
      getConfig: () => Promise.resolve({ providers: [providerB] }),
      getLocalPeriods: (provider, tier) => {
        calls.localReads.push({ provider, tier });
        return Promise.resolve(FIXTURE_MONTHS);
      },
    }, calls);

    await runOnce(deps);

    // 30-day hourly retention from 2026-03-02 keeps 2026-01 onward; the daily
    // 365-day window keeps everything. On the wall clock both would expire.
    expect(calls.deletes).toEqual([{ provider: 'aws-b', periods: ['2025-12'], tier: 'hourly' }]);
  });

  it('downloads only periods inside retention as of the injected clock', async () => {
    writePrefs({ autoSync: true, autoPrune: false });
    const calls = newCalls();
    const deps = buildDeps({
      now: () => PINNED_NOW,
      getConfig: () => Promise.resolve({ providers: [providerB] }),
      getInventory: (provider, tier) => {
        calls.inventory.push({ provider, tier });
        return Promise.resolve({
          periods: FIXTURE_MONTHS.map(period => ({
            period,
            localStatus: 'missing',
            files: [{ key: `${tier}-${period}.parquet`, contentHash: period, size: 1 }],
          })),
        });
      },
    }, calls);

    await runOnce(deps);

    expect(calls.sync).toEqual([
      { provider: 'aws-b', tier: 'daily', files: 3 },
      { provider: 'aws-b', tier: 'hourly', files: 2 },
    ]);
  });

  it('one provider\'s prune failure never aborts the other provider\'s prune', async () => {
    writePrefs({ autoSync: false, autoPrune: true });
    const calls = newCalls();
    const deps = buildDeps({
      getLocalPeriods: (provider, tier) => {
        calls.localReads.push({ provider, tier });
        if (provider === 'aws-a') return Promise.reject(new Error('EACCES'));
        return Promise.resolve(['2000-01']);
      },
    }, calls);

    await runOnce(deps);

    expect(calls.deletes).toEqual([
      { provider: 'aws-b', periods: ['2000-01'], tier: 'daily' },
      { provider: 'aws-b', periods: ['2000-01'], tier: 'hourly' },
    ]);
    expect(getAutoSyncStatus().state).toBe('idle');
  });

  it('goes disabled without touching any dep when both toggles are off', async () => {
    writePrefs({ autoSync: false, autoPrune: false });
    const calls = newCalls();
    let configReads = 0;
    const deps = buildDeps({
      getConfig: () => {
        configReads += 1;
        return Promise.resolve({ providers: [providerA, providerB] });
      },
    }, calls);

    await runOnce(deps);

    expect(getAutoSyncStatus().state).toBe('disabled');
    expect(configReads).toBe(0);
    expect(calls.inventory).toEqual([]);
    expect(calls.deletes).toEqual([]);
  });

  it('ends idle with nextRun null when no providers are configured', async () => {
    writePrefs({ autoSync: true, autoPrune: true });
    const calls = newCalls();
    const deps = buildDeps({ getConfig: () => Promise.resolve({ providers: [] }) }, calls);

    await runOnce(deps);

    const status = getAutoSyncStatus();
    expect(status.state).toBe('idle');
    if (status.state === 'idle') {
      expect(status.nextRun).toBeNull();
      expect(status.providerErrors).toBeUndefined();
    }
    expect(calls.inventory).toEqual([]);
  });
});

describe('auto-sync scheduler (startAutoSync)', () => {
  const MINUTE_MS = 60_000;
  const DAY_MS = 24 * 60 * MINUTE_MS;
  const DAILY_MINUTES = 24 * 60;
  // The "Monthly" option in scheduler-controls.tsx. Its 2,592,000,000 ms is
  // longer than a Node timer holds (2^31 - 1 ms), as is the 31-day maximum;
  // vitest's fake timers fire such a timer after 1 ms, as Node does.
  const MONTHLY_MINUTES = 43_200;
  const FIRST_PASS_DELAY_MS = 5_000;
  const provider: AutoSyncProvider = { name: 'aws-a', sync: { daily: { retentionDays: 365 } } };

  let base: string;
  let prefsFile: string;
  // Passes started (getPrefsPath is a pass's first, synchronous step), and
  // passes that got past their prefs reads to the config.
  let started: number;
  let configReads: number;
  // getConfig waits on this, so a test can hold a pass mid-run.
  let heldPass: Promise<void>;
  let releasePass: () => void;

  function schedulerDeps(): AutoSyncDeps {
    return {
      now: () => Date.now(),
      getPrefsPath: () => {
        started += 1;
        return Promise.resolve(prefsFile);
      },
      getConfig: async () => {
        configReads += 1;
        await heldPass;
        return { providers: [provider] };
      },
      getInventory: () => Promise.resolve({ periods: [] }),
      syncPeriods: (_provider, files) => Promise.resolve({ filesDownloaded: files.length }),
      getLocalPeriods: () => Promise.resolve([]),
      deletePeriods: () => Promise.resolve(),
    };
  }

  function holdNextPass(): void {
    heldPass = new Promise<void>((resolve) => { releasePass = () => { resolve(); }; });
  }

  // One real event-loop turn (setImmediate is left unfaked): every microtask
  // queued before it, such as a released pass and the re-arm after it, has run.
  function settle(): Promise<void> {
    return new Promise((resolve) => { setImmediate(resolve); });
  }

  // A pass reads the prefs file for real, which no fake clock can hurry: turn
  // the real event loop until pass `n` has read the config. Unless the test
  // holds it there, the rest of that pass and the scheduler's re-arm are
  // microtasks, so they have run by the time this returns.
  async function passesReach(n: number): Promise<void> {
    const deadline = performance.now() + 2_000;
    while (configReads < n && performance.now() < deadline) await settle();
    expect({ started, configReads }).toEqual({ started: n, configReads: n });
  }

  function reportedNextRun(): string | null {
    const status = getAutoSyncStatus();
    return status.state === 'idle' ? status.nextRun : null;
  }

  // Walk a just-started schedule through `cycles` passes after its first:
  // each lands exactly one interval after the previous one ended (when that
  // pass's status said it would) and not a tick sooner.
  async function expectPassEvery(intervalMs: number, cycles: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    await passesReach(1);
    for (let pass = 1; pass <= cycles; pass++) {
      const promised = reportedNextRun();
      // An overflowed timer fires every millisecond: a schedule armed with one
      // has run dozens of passes by the end of this first second.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(started).toBe(pass);
      await vi.advanceTimersByTimeAsync(intervalMs - 1_001);
      expect(started).toBe(pass);
      await vi.advanceTimersByTimeAsync(1);
      await passesReach(pass + 1);
      expect(new Date(Date.now()).toISOString()).toBe(promised);
    }
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'cg-auto-sync-schedule-'));
    prefsFile = join(base, 'app-preferences.json');
    writeFileSync(prefsFile, JSON.stringify({ autoSync: true, autoPrune: false }));
    started = 0;
    configReads = 0;
    heldPass = Promise.resolve();
    releasePass = () => undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'], now: Date.UTC(2026, 0, 1) });
  });

  afterEach(async () => {
    stopAutoSync();
    releasePass();
    // runOnce joins a pass still in flight: none runs on into the next test.
    await runOnce(schedulerDeps());
    vi.useRealTimers();
    rmSync(base, { recursive: true, force: true });
  });

  it.each([
    // Fits in one timer: the control case.
    { label: 'Daily', minutes: DAILY_MINUTES, intervalMs: DAY_MS },
    { label: 'Monthly', minutes: MONTHLY_MINUTES, intervalMs: MONTHLY_MINUTES * MINUTE_MS },
    // Clamped to the 31-day maximum.
    { label: 'over-the-maximum', minutes: 2 * MAX_AUTO_SYNC_INTERVAL_MINUTES, intervalMs: MAX_AUTO_SYNC_INTERVAL_MINUTES * MINUTE_MS },
  ])('runs a $label schedule once per interval, not continuously', async ({ minutes, intervalMs }) => {
    startAutoSync(schedulerDeps(), minutes);
    await expectPassEvery(intervalMs, 2);
  });

  it('counts the interval from an out-of-band pass, as that pass reported', async () => {
    const monthMs = MONTHLY_MINUTES * MINUTE_MS;
    startAutoSync(schedulerDeps(), MONTHLY_MINUTES);
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    await passesReach(1);

    // Ten days on, a credential recovery runs a pass out of band.
    await vi.advanceTimersByTimeAsync(10 * DAY_MS);
    triggerAutoSyncNow();
    await passesReach(2);
    const promised = reportedNextRun();

    // A month from the first pass comes and goes without another...
    await vi.advanceTimersByTimeAsync(monthMs - 10 * DAY_MS);
    expect(started).toBe(2);
    // ...which lands a month after the out-of-band one.
    await vi.advanceTimersByTimeAsync(10 * DAY_MS - 1);
    expect(started).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await passesReach(3);
    expect(new Date(Date.now()).toISOString()).toBe(promised);
  });

  it('folds a pass falling due mid-run into the pass running', async () => {
    startAutoSync(schedulerDeps(), DAILY_MINUTES);
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    await passesReach(1);

    // An out-of-band pass is still going when the daily one falls due.
    await vi.advanceTimersByTimeAsync(DAY_MS - MINUTE_MS);
    holdNextPass();
    triggerAutoSyncNow();
    await passesReach(2);
    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);
    expect(started).toBe(2);
    // The schedule waits on that pass, no timer spinning in the meantime.
    expect(vi.getTimerCount()).toBe(0);

    // It stands in for the daily pass: the next is a day after it ends.
    releasePass();
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(DAY_MS - 1);
    expect(started).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await passesReach(3);
  });

  it('leaves only the new schedule when restarted mid-pass', async () => {
    holdNextPass();
    startAutoSync(schedulerDeps(), DAILY_MINUTES);
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    await passesReach(1);

    // The interval changes while that pass is still running.
    startAutoSync(schedulerDeps(), 7 * DAILY_MINUTES);
    releasePass();
    await settle();
    // The old pass ended without arming anything: the new schedule's first
    // pass is the only timer.
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    await passesReach(2);
    await vi.advanceTimersByTimeAsync(7 * DAY_MS - 1);
    expect(started).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await passesReach(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('keeps going when the wall clock is set back past the last pass', async () => {
    startAutoSync(schedulerDeps(), DAILY_MINUTES);
    await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS);
    await passesReach(1);

    // A year back (an NTP correction, say). Pending timers keep their delays,
    // as Node's do. The next pass may slip one interval while the schedule
    // re-anchors, but it must not wait for the clock to catch up.
    vi.setSystemTime(Date.now() - 365 * DAY_MS);
    await vi.advanceTimersByTimeAsync(2 * DAY_MS);
    await passesReach(2);
  });
});
