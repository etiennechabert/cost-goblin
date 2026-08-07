import { logger } from '@costgoblin/core';
import type { ManifestFileEntry, ProviderAuth, SyncProgress, SyncLogLevel } from '@costgoblin/core';
import { initWorkerLifecycle } from './worker-lifecycle.js';

/** A log line forwarded from the sync worker thread. */
export type SyncLogSink = (level: SyncLogLevel, message: string, ts: number) => void;

export interface SyncOptions {
  readonly bucketPath: string;
  /** How the provider authenticates. Crosses the worker-thread boundary by
   *  structured clone and is re-validated on arrival (`isProviderAuth`). */
  readonly auth: ProviderAuth;
  /** Which configured provider's tree (`{dataDir}/{providerName}/…`) the
   *  download lands in. Crosses the worker-thread boundary as a plain string;
   *  the worker re-validates it with `parseProviderName` before it touches
   *  any path. Main passes `provider.name` from config. */
  readonly providerName: string;
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
  | { kind: 'progress'; id: number; phase: 'downloading' | 'repartitioning' | 'done'; filesDone: number; filesTotal: number; bytesDone?: number; bytesTotal?: number; message?: string }
  | { kind: 'complete'; id: number; filesDownloaded: number; rowsProcessed: number }
  | { kind: 'error'; id: number; message: string }
  | { kind: 'log'; level: SyncLogLevel; message: string; ts: number };

function hasProps(msg: unknown): msg is Record<string, unknown> {
  return typeof msg === 'object' && msg !== null;
}

function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (!hasProps(msg)) return false;
  if (msg['kind'] === 'ready') return true;
  if (msg['kind'] === 'log') {
    return typeof msg['message'] === 'string' && typeof msg['ts'] === 'number' && typeof msg['level'] === 'string';
  }
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

export async function createSyncClient(workerPath: string, onLog?: SyncLogSink): Promise<SyncClient> {
  const lifecycle = await initWorkerLifecycle<PendingSync>(
    workerPath,
    (msg) => isWorkerResponse(msg) && msg.kind === 'ready',
    (msg) => {
      if (!isWorkerResponse(msg)) return null;
      if (msg.kind === 'error' && msg.id === -1) return msg.message;
      return null;
    },
  );
  const { worker, pending } = lifecycle;

  worker.on('message', (msg: unknown) => {
    if (!isWorkerResponse(msg)) return;
    if (msg.kind === 'ready') return;
    if (msg.kind === 'log') {
      // Log lines aren't tied to a request id — they stream for the whole
      // worker lifetime and feed the sync activity log.
      onLog?.(msg.level, msg.message, msg.ts);
      return;
    }

    const entry = pending.get(msg.id);
    if (entry === undefined) return;

    if (msg.kind === 'progress') {
      entry.onProgress?.({
        phase: msg.phase,
        filesTotal: msg.filesTotal,
        filesDone: msg.filesDone,
        ...(msg.bytesDone === undefined ? {} : { bytesDone: msg.bytesDone }),
        ...(msg.bytesTotal === undefined ? {} : { bytesTotal: msg.bytesTotal }),
        ...(msg.message === undefined ? {} : { message: msg.message }),
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

  return {
    syncPeriods(options: SyncOptions): Promise<SyncResult> {
      if (lifecycle.fatalError !== null) return Promise.reject(lifecycle.fatalError);
      const id = lifecycle.nextId++;
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
          auth: options.auth,
          providerName: options.providerName,
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
