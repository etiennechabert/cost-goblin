import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSyncClient, SYNC_CLIENT_TERMINATED_MESSAGE } from '../main/sync-client.js';
import type { SyncOptions } from '../main/sync-client.js';
import { drainWorkersSync, liveDrainables, waitCounterSync } from '../main/worker-drain.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'sync-worker.cjs');
const STUB_WORKER_PATH = fileURLToPath(new URL('./fixtures/stub-sync-worker.mjs', import.meta.url));

if (!existsSync(workerPath)) {
  throw new Error(
    `Worker bundle not found at ${workerPath}. Run "npm run build:worker" in packages/desktop first.`,
  );
}

/** Far more than a drain needs, far less than the test timeout. */
const DRAIN_BUDGET_MS = 10_000;

function opts(dataDir: string, syncKey: string): SyncOptions {
  return {
    bucketPath: 's3://test-bucket/test',
    auth: { kind: 'aws-profile', profile: 'default' },
    providerName: 'aws',
    dataDir,
    tier: 'daily',
    files: [],
    syncKey,
  };
}

// The sync worker runs DuckDB (GCP canonicalization), so the app's exit handler
// drains it with the DuckDB workers: tearing its thread down under a running
// query aborts the whole process.
describe('SyncClient exit drain', () => {
  it('waits for a sync in flight, then refuses new syncs', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'costgoblin-sync-client-drain-'));
    const client = await createSyncClient(workerPath);
    try {
      const inFlight = client.syncPeriods(opts(dataDir, 'aws:daily')).then(() => 'settled', () => 'settled');

      expect(drainWorkersSync(DRAIN_BUDGET_MS)).toBe(true);
      // A second drain asks nothing more of the worker and still holds.
      expect(drainWorkersSync(DRAIN_BUDGET_MS)).toBe(true);
      expect(await inFlight).toBe('settled');

      await expect(client.syncPeriods(opts(dataDir, 'aws:hourly'))).rejects.toThrow(SYNC_CLIENT_TERMINATED_MESSAGE);
    } finally {
      await client.terminate();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('leaves the registry once its worker has exited', async () => {
    const client = await createSyncClient(workerPath);
    const before = liveDrainables.size;
    await client.terminate();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    expect(liveDrainables.size).toBe(before - 1);
    expect(drainWorkersSync(0)).toBe(true);
  });

  it('does not wait on a worker that shares no counter', async () => {
    const client = await createSyncClient(STUB_WORKER_PATH);
    try {
      expect(drainWorkersSync(0)).toBe(true);
    } finally {
      await client.terminate();
    }
  });
});

describe('waitCounterSync', () => {
  it('is false at the deadline while requests are still in flight', () => {
    const counter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    expect(waitCounterSync(counter, () => 1, Date.now(), () => false)).toBe(false);
  });

  it('is true once the counter has caught up, or the worker exited', () => {
    const counter = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    Atomics.store(counter, 0, 2);
    expect(waitCounterSync(counter, () => 2, Date.now(), () => false)).toBe(true);
    expect(waitCounterSync(counter, () => 5, Date.now(), () => true)).toBe(true);
  });
});
