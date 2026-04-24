import { Worker } from 'node:worker_threads';
import { logger } from '@costgoblin/core';
import type { ManifestFileEntry, SyncProgress } from '@costgoblin/core';

export interface SyncOptions {
  readonly bucketPath: string;
  readonly profile: string;
  readonly dataDir: string;
  readonly tier?: 'daily' | 'hourly' | 'cost-optimization' | undefined;
  readonly files: readonly ManifestFileEntry[];
  readonly onProgress?: ((progress: SyncProgress) => void) | undefined;
}

export interface SyncResult {
  readonly filesDownloaded: number;
  readonly rowsProcessed: number;
}

export interface SyncClient {
  syncPeriods(options: SyncOptions): Promise<SyncResult>;
  cancelSync(id: number): void;
  terminate(): Promise<void>;
}

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'progress'; id: number; phase: 'downloading' | 'repartitioning' | 'done'; filesDone: number; filesTotal: number; message?: string }
  | { kind: 'complete'; id: number; filesDownloaded: number; rowsProcessed: number }
  | { kind: 'error'; id: number; message: string };

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (!hasProps(msg)) return false;
  if (msg['kind'] === 'ready') return true;
  if ((msg['kind'] === 'progress' || msg['kind'] === 'complete' || msg['kind'] === 'error') && typeof msg['id'] === 'number') {
    if (msg['kind'] === 'progress') {
      return (
        (msg['phase'] === 'downloading' || msg['phase'] === 'repartitioning' || msg['phase'] === 'done') &&
        typeof msg['filesDone'] === 'number' &&
        typeof msg['filesTotal'] === 'number'
      );
    }
    if (msg['kind'] === 'complete') {
      return typeof msg['filesDownloaded'] === 'number' && typeof msg['rowsProcessed'] === 'number';
    }
    return typeof msg['message'] === 'string';
  }
  return false;
}

interface PendingSync {
  resolve: (result: SyncResult) => void;
  reject: (err: Error) => void;
  onProgress?: ((progress: SyncProgress) => void) | undefined;
}

export async function createSyncClient(workerPath: string): Promise<SyncClient> {
  const worker = new Worker(workerPath);
  const pending = new Map<number, PendingSync>();
  let nextId = 0;
  let fatalError: Error | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: unknown): void => {
      if (!isWorkerResponse(msg)) return;
      if (msg.kind === 'ready') {
        worker.off('message', onMessage);
        resolve();
        return;
      }
      if (msg.kind === 'error' && msg.id === -1) {
        worker.off('message', onMessage);
        const err = new Error(msg.message);
        fatalError = err;
        reject(err);
        return;
      }
    };
    worker.on('message', onMessage);
    worker.once('error', (err) => { fatalError = err; reject(err); });
  });

  worker.on('message', (msg: unknown) => {
    if (!isWorkerResponse(msg)) return;
    if (msg.kind === 'ready') return;

    const entry = pending.get(msg.id);
    if (entry === undefined) return;

    if (msg.kind === 'progress') {
      entry.onProgress?.({
        phase: msg.phase,
        filesTotal: msg.filesTotal,
        filesDone: msg.filesDone,
        ...(msg.message !== undefined ? { message: msg.message } : {}),
      });
    } else {
      pending.delete(msg.id);
      if (msg.kind === 'complete') {
        entry.resolve({ filesDownloaded: msg.filesDownloaded, rowsProcessed: msg.rowsProcessed });
      } else {
        entry.reject(new Error(msg.message));
      }
    }
  });

  worker.on('error', (err) => {
    fatalError = err;
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      const err = new Error(`Sync worker exited unexpectedly with code ${String(code)}`);
      fatalError ??= err;
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    }
  });

  await ready;

  return {
    syncPeriods(options: SyncOptions): Promise<SyncResult> {
      if (fatalError !== null) return Promise.reject(fatalError);
      const id = nextId++;
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      return new Promise<SyncResult>((resolve, reject) => {
        pending.set(id, {
          resolve: (result) => {
            logger.debug('sync:complete', {
              id,
              startedAt: startedAtIso,
              durationMs: Date.now() - startedAt,
              filesDownloaded: result.filesDownloaded,
              rowsProcessed: result.rowsProcessed,
              bucketPath: options.bucketPath,
            });
            resolve(result);
          },
          reject: (err) => {
            logger.debug('sync:failed', {
              id,
              startedAt: startedAtIso,
              durationMs: Date.now() - startedAt,
              error: err.message,
              bucketPath: options.bucketPath,
            });
            reject(err);
          },
          onProgress: options.onProgress,
        });
        worker.postMessage({
          kind: 'sync',
          id,
          bucketPath: options.bucketPath,
          profile: options.profile,
          dataDir: options.dataDir,
          tier: options.tier ?? 'daily',
          files: options.files,
        });
      });
    },
    cancelSync(id: number): void {
      worker.postMessage({ kind: 'cancel', id });
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}
