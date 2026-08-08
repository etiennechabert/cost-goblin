import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createSyncClient, SYNC_ALREADY_RUNNING } from '../main/sync-client.js';
import type { SyncClient, SyncOptions } from '../main/sync-client.js';

/** Exercises the SyncClient's two invariants against a stub worker: one
 *  in-flight sync per {provider}:{tier} key (mutex), and cancellation targeted
 *  by that same key. Together they replaced a handler-local counter that
 *  drifted from the worker's real request id whenever auto-sync ran. */

const WORKER_PATH = fileURLToPath(new URL('./fixtures/stub-sync-worker.mjs', import.meta.url));

function opts(syncKey: string, bucketPath = 'gs://b/hang'): SyncOptions {
  return {
    bucketPath,
    auth: { kind: 'aws-profile', profile: 'default' },
    providerName: 'p',
    dataDir: '/tmp/none',
    tier: 'daily',
    files: [],
    syncKey,
  };
}

const flush = (): Promise<void> => new Promise(resolve => { setImmediate(resolve); });

describe('SyncClient per-key mutex and keyed cancel', () => {
  let client: SyncClient;

  beforeAll(async () => {
    client = await createSyncClient(WORKER_PATH);
  });

  afterAll(async () => {
    await client.terminate();
  });

  it('rejects a second start for a key already in flight', async () => {
    const first = client.syncPeriods(opts('aws:daily'));
    // Second start for the SAME key while the first hangs → rejected.
    await expect(client.syncPeriods(opts('aws:daily'))).rejects.toThrow(SYNC_ALREADY_RUNNING);
    // The first is still live; cancelling it settles the promise and frees the key.
    client.cancelSync('aws:daily');
    await expect(first).rejects.toThrow('Download cancelled');
  });

  it('allows a different key to run concurrently', async () => {
    const daily = client.syncPeriods(opts('aws:daily'));
    const hourly = client.syncPeriods(opts('aws:hourly'));
    await flush();
    // Neither rejected synchronously — distinct keys don't contend.
    client.cancelSync('aws:daily');
    client.cancelSync('aws:hourly');
    await expect(daily).rejects.toThrow('Download cancelled');
    await expect(hourly).rejects.toThrow('Download cancelled');
  });

  it('cancel targets only the named key', async () => {
    const daily = client.syncPeriods(opts('aws:daily'));
    const hourly = client.syncPeriods(opts('aws:hourly'));
    await flush();
    client.cancelSync('aws:daily');
    await expect(daily).rejects.toThrow('Download cancelled');
    // hourly is untouched — still in flight; clean it up.
    client.cancelSync('aws:hourly');
    await expect(hourly).rejects.toThrow('Download cancelled');
  });

  it('frees the key once a sync completes, allowing a fresh start', async () => {
    // 'complete-now' makes the stub resolve immediately, releasing the key.
    await expect(client.syncPeriods(opts('aws:daily', 'gs://complete-now'))).resolves.toEqual({
      filesDownloaded: 1,
      rowsProcessed: 10,
    });
    // Key is free again — a subsequent start is accepted, not rejected.
    const again = client.syncPeriods(opts('aws:daily'));
    client.cancelSync('aws:daily');
    await expect(again).rejects.toThrow('Download cancelled');
  });

  it('cancel for an unknown key is a harmless no-op', () => {
    expect(() => { client.cancelSync('nope:daily'); }).not.toThrow();
  });
});
