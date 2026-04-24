import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerPath = join(__dirname, '..', '..', 'out', 'worker', 'sync-worker.cjs');

interface WorkerMsg { kind: string; id?: number; [key: string]: unknown }

function isMsg(msg: unknown): msg is WorkerMsg {
  return typeof msg === 'object' && msg !== null && 'kind' in msg;
}

describe('Sync Worker', () => {
  let worker: Worker;
  let testDataDir: string;
  let nextId = 1;

  function sendSync(id: number, overrides?: Record<string, unknown>): void {
    worker.postMessage({
      kind: 'sync',
      id,
      bucketPath: 's3://test-bucket/test',
      profile: 'default',
      dataDir: testDataDir,
      tier: 'daily',
      files: [],
      ...overrides,
    });
  }

  function waitForResult(id: number): Promise<WorkerMsg> {
    return new Promise<WorkerMsg>((resolve) => {
      const handler = (msg: unknown): void => {
        if (isMsg(msg) && msg.id === id && (msg.kind === 'complete' || msg.kind === 'error')) {
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
      worker.once('error', (err) => { clearTimeout(timeout); reject(err); });
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
    expect(result).toHaveProperty('id', id);
    expect(result.kind).toBe('complete');
    expect(result).toHaveProperty('filesDownloaded', 0);
    expect(result).toHaveProperty('rowsProcessed', 0);
  });

  it('ignores malformed messages without crashing', async () => {
    worker.postMessage('invalid');
    worker.postMessage(null);
    worker.postMessage({ kind: 'sync', id: 999 }); // missing required fields
    worker.postMessage({ kind: 'cancel' }); // missing id

    // Worker should still respond to valid messages
    const id = nextId++;
    sendSync(id);
    const result = await waitForResult(id);
    expect(result.kind).toBe('complete');
  });

  it('handles cancel without crashing', async () => {
    const id = nextId++;
    sendSync(id);
    worker.postMessage({ kind: 'cancel', id });
    const result = await waitForResult(id);
    // Either completed before cancel arrived, or was cancelled
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
    const result = await waitForResult(afterId);
    expect(result.kind).toBe('complete');
  });

  it('handles sequential syncs with correct IDs', async () => {
    const ids = [nextId++, nextId++, nextId++];
    for (const id of ids) {
      sendSync(id);
      const result = await waitForResult(id);
      expect(result.id).toBe(id);
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
});
