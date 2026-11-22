import { describe, it, expect } from 'vitest';
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

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

async function startWorker(): Promise<{ worker: Worker; settled: Int32Array }> {
  const worker = new Worker(workerPath);
  const settled = await new Promise<Int32Array>((resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error('Worker ready timeout')); }, 5000);
    const onMessage = (msg: unknown): void => {
      if (!hasProps(msg) || msg['kind'] !== 'ready') return;
      clearTimeout(timeout);
      worker.off('message', onMessage);
      if (!(msg['settled'] instanceof SharedArrayBuffer)) {
        reject(new Error('ready message carries no settled counter'));
        return;
      }
      resolve(new Int32Array(msg['settled']));
    };
    worker.on('message', onMessage);
  });
  return { worker, settled };
}

function waitForCount(counter: Int32Array, target: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = Atomics.load(counter, 0);
    if (seen >= target) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    Atomics.wait(counter, 0, seen, left);
  }
}

// The sync worker runs DuckDB (GCP canonicalization). The app's exit handler
// drains it through a shared counter of settled requests: every 'sync' message
// must settle it, and nothing may start once a drain has begun.
describe('Sync worker drain', () => {
  it('settles every posted sync, malformed ones included, and refuses syncs after a drain', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'costgoblin-sync-drain-'));
    const { worker, settled } = await startWorker();
    try {
      const sync = (id: number): Record<string, unknown> => ({
        kind: 'sync',
        id,
        bucketPath: 's3://test-bucket/test',
        auth: { kind: 'aws-profile', profile: 'default' },
        providerName: 'aws',
        dataDir,
        tier: 'daily',
        files: [],
      });

      worker.postMessage(sync(1));
      worker.postMessage({ kind: 'sync', id: 2, tier: 'bogus' });
      expect(waitForCount(settled, 2, 10_000)).toBe(true);

      const refused = new Promise<unknown>((resolve) => {
        worker.on('message', (msg: unknown) => {
          if (hasProps(msg) && msg['id'] === 3 && msg['kind'] !== 'progress') resolve(msg);
        });
      });
      worker.postMessage({ kind: 'drain' });
      worker.postMessage(sync(3));
      expect(await refused).toEqual({ kind: 'error', id: 3, message: 'Download cancelled' });
      expect(Atomics.load(settled, 0)).toBe(3);
    } finally {
      await worker.terminate();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
