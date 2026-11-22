import { logger } from '@costgoblin/core';
import type { ManifestFileEntry, ProviderAuth, SyncProgress, SyncLogLevel } from '@costgoblin/core';
import { initWorkerLifecycle } from './worker-lifecycle.js';
import { liveDrainables, waitCounterSync } from './worker-drain.js';
import type { Drainable } from './worker-drain.js';

/** A log line forwarded from the sync worker thread. */
export type SyncLogSink = (level: SyncLogLevel, message: string, ts: number) => void;

/** Rejection message when a sync is started for a (provider, tier) that already
 *  has one in flight. Callers treat this as a coalesced no-op rather than a
 *  failure — the running sync will deliver the same data. */
export const SYNC_ALREADY_RUNNING = 'A sync for this provider and tier is already in progress';

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
  /** Stable `{provider}:{tier}` identity for this sync. It is the single
   *  authority for both mutual exclusion (a second start for the same key is
   *  rejected with {@link SYNC_ALREADY_RUNNING}) and cancellation (`cancelSync`
   *  targets the in-flight worker request by this key). Replacing the old
   *  handler-local counter — which drifted from the worker's real request id
   *  whenever auto-sync ran, so cancel hit the wrong download or none. */
  readonly syncKey: string;
}

export interface SyncResult {
  readonly filesDownloaded: number;
  readonly rowsProcessed: number;
}

export interface SyncClient {
  syncPeriods(options: SyncOptions): Promise<SyncResult>;
  /** Cancel the in-flight sync for `syncKey`, if any. No-op when nothing is
   *  running under that key. */
  cancelSync(syncKey: string): void;
  terminate(): Promise<void>;
}

/** What a sync started after the exit drain began is rejected with. */
export const SYNC_CLIENT_TERMINATED_MESSAGE = 'Sync client terminated';

type WorkerResponse =
  | { kind: 'ready'; settled?: unknown }
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
  // The worker's count of settled sync requests, from its ready message. A
  // worker that sends none can't be waited on.
  let settledCount: Int32Array | undefined;
  const lifecycle = await initWorkerLifecycle<PendingSync>(
    workerPath,
    (msg) => {
      if (!isWorkerResponse(msg) || msg.kind !== 'ready') return false;
      if (msg.settled instanceof SharedArrayBuffer) settledCount = new Int32Array(msg.settled);
      return true;
    },
    (msg) => {
      if (!isWorkerResponse(msg)) return null;
      if (msg.kind === 'error' && msg.id === -1) return msg.message;
      return null;
    },
  );
  const { worker, pending } = lifecycle;
  /** In-flight worker request id per `syncKey`. One entry at most per key: a
   *  second start for a live key is rejected below, so this doubles as the
   *  per-(provider,tier) mutex and the cancellation target. */
  const activeByKey = new Map<string, number>();

  // The exit drain (worker-drain.ts): the sync worker runs DuckDB for GCP
  // canonicalization, and tearing its thread down under a running query
  // aborts the process.
  /** Sync requests posted to the worker: its settled count catches up with
   *  this once nothing is in flight. */
  let posted = 0;
  let exited = false;
  let drainRequested = false;
  const drainable: Drainable = {
    beginDrain(): void {
      lifecycle.fatalError ??= new Error(SYNC_CLIENT_TERMINATED_MESSAGE);
      if (drainRequested || exited || settledCount === undefined) return;
      drainRequested = true;
      worker.postMessage({ kind: 'drain' });
    },
    waitSettledSync(deadline: number): boolean {
      const counter = settledCount;
      if (counter === undefined) return true;
      return waitCounterSync(counter, () => posted, deadline, () => exited);
    },
  };
  liveDrainables.add(drainable);
  worker.on('exit', () => {
    exited = true;
    liveDrainables.delete(drainable);
  });

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
      // Airtight per-key mutex: this method runs synchronously up to the
      // postMessage, so two starts for the same key can never both pass. Guards
      // the GCP staging/etag corruption a concurrent manual+auto sync caused.
      if (activeByKey.has(options.syncKey)) return Promise.reject(new Error(SYNC_ALREADY_RUNNING));
      const id = lifecycle.nextId++;
      activeByKey.set(options.syncKey, id);
      const settle = (): void => { if (activeByKey.get(options.syncKey) === id) activeByKey.delete(options.syncKey); };
      const startedAt = Date.now();
      const startedAtIso = new Date(startedAt).toISOString();
      return new Promise<SyncResult>((resolve, reject) => {
        pending.set(id, {
          resolve: (result) => {
            settle();
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
            settle();
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
        posted += 1;
      });
    },
    cancelSync(syncKey: string): void {
      const id = activeByKey.get(syncKey);
      if (id === undefined) return;
      worker.postMessage({ kind: 'cancel', id });
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}
