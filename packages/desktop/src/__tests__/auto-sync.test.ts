import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalSyncStateError } from '@costgoblin/core';
import { runOnce, getAutoSyncStatus, type AutoSyncDeps, type AutoSyncProvider } from '../main/auto-sync.js';
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
