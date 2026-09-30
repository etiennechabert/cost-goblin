import type { DuckDbSandboxOptions } from '@costgoblin/core';
import { initWorkerLifecycle } from './worker-lifecycle.js';

export type RawRow = Readonly<Record<string, unknown>>;

export interface DuckDBClient {
  runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]>;
  runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]>;
  /** Run on a brand-new connection that is disposed afterward (never pooled).
   *  Used for rollup partition builds so per-build time stays flat — a reused
   *  connection's buffer/cache accumulates and later builds slow down. */
  runBuildQuery(sql: string, onStarted?: () => void): Promise<RawRow[]>;
  cancelPendingQueries(): void;
  configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void;
  terminate(): Promise<void>;
}

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'started'; id: number }
  | { kind: 'rows'; id: number; rows: RawRow[] }
  | { kind: 'error'; id: number; message: string };

function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m['kind'] === 'ready') return true;
  if (m['kind'] === 'started' && typeof m['id'] === 'number') return true;
  if ((m['kind'] === 'rows' || m['kind'] === 'error') && typeof m['id'] === 'number') {
    if (m['kind'] === 'rows') return Array.isArray(m['rows']);
    return typeof m['message'] === 'string';
  }
  return false;
}

interface PendingQuery {
  resolve: (rows: RawRow[]) => void;
  reject: (err: Error) => void;
  onStarted?: (() => void) | undefined;
}

/** Data handed to the DuckDB worker at spawn. `sandbox` switches the worker to
 *  a dedicated, locked-down instance (see `buildDuckDbSandboxStatements`); the
 *  worker applies it before reporting ready and fails init if it can't. */
export interface DuckDBWorkerData {
  readonly sandbox: DuckDbSandboxOptions;
}

/** How long terminate() waits for interrupted queries to settle. */
const TERMINATE_GRACE_MS = 10_000;

/** Spawn a DuckDB worker. Without `workerData` it is the app's shared,
 *  unrestricted instance; with `workerData.sandbox` it is sandboxed and locked,
 *  and the promise rejects (with the worker already terminated) if the sandbox
 *  cannot be applied — callers must not fall back to an unsandboxed client. */
export async function createDuckDBClient(workerPath: string, workerData?: DuckDBWorkerData): Promise<DuckDBClient> {
  const lifecycle = await initWorkerLifecycle<PendingQuery>(
    workerPath,
    (msg) => isWorkerResponse(msg) && msg.kind === 'ready',
    (msg) => {
      if (!isWorkerResponse(msg)) return null;
      if (msg.kind === 'error' && msg.id === -1) return msg.message;
      return null;
    },
    workerData,
  );
  const { worker, pending } = lifecycle;
  /** Settles (never rejects) when each submitted query does — what terminate()
   *  waits on after interrupting them. */
  const inFlight = new Set<Promise<void>>();

  worker.on('message', (msg: unknown) => {
    if (!isWorkerResponse(msg)) return;
    if (msg.kind === 'ready') return;
    if (msg.kind === 'started') {
      const entry = pending.get(msg.id);
      if (entry?.onStarted !== undefined) entry.onStarted();
      return;
    }
    const entry = pending.get(msg.id);
    if (entry === undefined) return;
    pending.delete(msg.id);
    if (msg.kind === 'rows') entry.resolve(msg.rows);
    else entry.reject(new Error(msg.message));
  });

  function submitQuery(
    kind: string,
    sql: string,
    extraPayload: Record<string, unknown>,
    onStarted?: () => void,
  ): Promise<RawRow[]> {
    if (lifecycle.fatalError !== null) return Promise.reject(lifecycle.fatalError);
    const id = lifecycle.nextId++;
    const query = new Promise<RawRow[]>((resolve, reject) => {
      pending.set(id, { onStarted, resolve, reject });
      worker.postMessage({ kind, id, sql, ...extraPayload });
    });
    const settled = query.then(() => undefined, () => undefined);
    inFlight.add(settled);
    void settled.then(() => { inFlight.delete(settled); });
    return query;
  }

  return {
    runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('query', sql, {}, onStarted);
    },
    runBuildQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('query', sql, { fresh: true }, onStarted);
    },
    runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('prepared-query', sql, { params }, onStarted);
    },
    cancelPendingQueries(): void {
      worker.postMessage({ kind: 'cancel-pending' });
    },
    configure(settings: { tempDir?: string; memoryGB?: number; threads?: number }): void {
      worker.postMessage({ kind: 'configure', ...settings });
    },
    async terminate(): Promise<void> {
      // worker.terminate() cannot stop a native DuckDB query: it blocks until
      // the query returns, and the addon then throws into the torn-down worker
      // and aborts the whole process. So interrupt first and let every query
      // settle (the worker answers each with the cancellation error), bounded
      // in case an interrupt is never acknowledged.
      if (inFlight.size > 0) {
        worker.postMessage({ kind: 'cancel-pending' });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const grace = new Promise<void>((resolve) => { timer = setTimeout(resolve, TERMINATE_GRACE_MS); });
        await Promise.race([Promise.all(inFlight), grace]);
        clearTimeout(timer);
      }
      await worker.terminate();
    },
  };
}
