import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'sync-worker.cjs');

if (!existsSync(workerPath)) {
  throw new Error(
    `Worker bundle not found at ${workerPath}. Run "npm run build:worker" in packages/desktop first.`,
  );
}

// ---------------------------------------------------------------------------
// Response types — mirrors WorkerResponse from sync-worker.ts
// ---------------------------------------------------------------------------

interface CompleteMsg {
  kind: 'complete';
  id: number;
  filesDownloaded: number;
  rowsProcessed: number;
}

interface SyncErrorMsg {
  kind: 'error';
  id: number;
  message: string;
}

type SyncResultMsg = CompleteMsg | SyncErrorMsg;

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isSyncResultMsg(msg: unknown): msg is SyncResultMsg {
  if (!hasProps(msg) || typeof msg['id'] !== 'number') return false;
  if (msg['kind'] === 'complete' && typeof msg['filesDownloaded'] === 'number') return true;
  if (msg['kind'] === 'error' && typeof msg['message'] === 'string') return true;
  return false;
}

// ---------------------------------------------------------------------------

describe('Sync Worker', () => {
  let worker: Worker;
  let testDataDir: string;
  let nextId = 1;

  function sendSync(id: number, overrides?: Record<string, unknown>): void {
    worker.postMessage({
      kind: 'sync',
      id,
      bucketPath: 's3://test-bucket/test',
      auth: { kind: 'aws-profile', profile: 'default' },
      providerName: 'aws',
      dataDir: testDataDir,
      tier: 'daily',
      files: [],
      ...overrides,
    });
  }

  function waitForResult(id: number): Promise<SyncResultMsg> {
    return new Promise<SyncResultMsg>((resolve) => {
      const handler = (msg: unknown): void => {
        if (isSyncResultMsg(msg) && msg.id === id) {
          worker.off('message', handler);
          resolve(msg);
        }
      };
      worker.on('message', handler);
    });
  }

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), 'costgoblin-sync-test-'));
    worker = new Worker(workerPath);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('Worker ready timeout')); }, 5000);
      worker.once('message', (msg) => {
        clearTimeout(timeout);
        expect(msg).toEqual({ kind: 'ready' });
        resolve();
      });
      worker.once('error', (e: unknown) => {
        clearTimeout(timeout);
        reject(e instanceof Error ? e : new Error(String(e)));
      });
    });
  });

  afterAll(async () => {
    await worker.terminate();
    await rm(testDataDir, { recursive: true, force: true });
  });

  it('completes sync with empty files', async () => {
    const id = nextId++;
    sendSync(id);
    const result = await waitForResult(id);
    expect(result).toMatchObject({ id, kind: 'complete', filesDownloaded: 0, rowsProcessed: 0 });
  });

  it('ignores malformed messages without crashing', async () => {
    worker.postMessage('invalid');
    worker.postMessage(null);
    worker.postMessage({ kind: 'sync', id: 999 });
    worker.postMessage({ kind: 'cancel' });

    const id = nextId++;
    sendSync(id);
    expect((await waitForResult(id)).kind).toBe('complete');
  });

  it('handles cancel without crashing', async () => {
    const id = nextId++;
    sendSync(id);
    worker.postMessage({ kind: 'cancel', id });
    const result = await waitForResult(id);
    expect(['complete', 'error']).toContain(result.kind);
    expect(result.id).toBe(id);
  });

  it('remains healthy after cancellation', async () => {
    const cancelId = nextId++;
    sendSync(cancelId);
    worker.postMessage({ kind: 'cancel', id: cancelId });
    await waitForResult(cancelId);

    const afterId = nextId++;
    sendSync(afterId);
    expect((await waitForResult(afterId)).kind).toBe('complete');
  });

  it('handles sequential syncs with correct IDs', async () => {
    const ids = [nextId++, nextId++, nextId++];
    for (const id of ids) {
      sendSync(id);
      expect((await waitForResult(id)).id).toBe(id);
    }
  });

  it('handles concurrent syncs without cross-talk', async () => {
    const id1 = nextId++;
    const id2 = nextId++;
    sendSync(id1, { bucketPath: 's3://bucket/a' });
    sendSync(id2, { bucketPath: 's3://bucket/b' });
    const [r1, r2] = await Promise.all([waitForResult(id1), waitForResult(id2)]);
    expect(r1.id).toBe(id1);
    expect(r2.id).toBe(id2);
  });

  it('routes a gcp auth descriptor to the GCP sync path', async () => {
    const id = nextId++;
    sendSync(id, {
      bucketPath: 'gs://focus-export/focus',
      auth: { kind: 'gcp' },
      providerName: 'gcp-main',
    });
    // No files requested → nothing to download, so the gcp branch completes
    // the same way the aws one does. What this pins is that the request
    // *reaches* a branch at all: an `auth` shape the worker's guard rejects
    // is dropped silently and this promise would never settle.
    expect(await waitForResult(id)).toMatchObject({ id, kind: 'complete', filesDownloaded: 0 });
  });

  it('accepts a gcp auth descriptor carrying a service-account key file', async () => {
    const id = nextId++;
    sendSync(id, {
      bucketPath: 'gs://focus-export/focus',
      auth: { kind: 'gcp', keyFile: '/tmp/does-not-need-to-exist.json' },
      providerName: 'gcp-main',
    });
    expect((await waitForResult(id)).kind).toBe('complete');
  });

  it('drops a request whose auth or tier is malformed, then keeps serving', async () => {
    // These must not settle — the point is that a bad message can't take the
    // worker down. The following well-formed request proves it is still alive.
    worker.postMessage({ kind: 'sync', id: 9001, bucketPath: 's3://b/p', auth: { kind: 'nope' }, providerName: 'aws', dataDir: testDataDir, tier: 'daily', files: [] });
    worker.postMessage({ kind: 'sync', id: 9002, bucketPath: 's3://b/p', auth: { kind: 'aws-profile', profile: 'default' }, providerName: 'aws', dataDir: testDataDir, tier: 'weekly', files: [] });
    // The pre-#517 wire shape, in case a stale main process is talking to a
    // freshly built worker.
    worker.postMessage({ kind: 'sync', id: 9003, bucketPath: 's3://b/p', profile: 'default', providerName: 'aws', dataDir: testDataDir, tier: 'daily', files: [] });

    const id = nextId++;
    sendSync(id);
    expect((await waitForResult(id)).kind).toBe('complete');
  });
});
