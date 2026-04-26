import { logger } from '@costgoblin/core';
import { initWorkerLifecycle } from './worker-lifecycle.js';

export type RawRow = Readonly<Record<string, unknown>>;

export interface DuckDBClient {
  runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]>;
  runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]>;
  cancelPendingQueries(): void;
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

export async function createDuckDBClient(workerPath: string): Promise<DuckDBClient> {
  const lifecycle = await initWorkerLifecycle<PendingQuery>(
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
    logTag: string,
    extraPayload: Record<string, unknown>,
    extraLogFields: Record<string, unknown>,
    onStarted?: () => void,
  ): Promise<RawRow[]> {
    if (lifecycle.fatalError !== null) return Promise.reject(lifecycle.fatalError);
    const id = lifecycle.nextId++;
    const startedAt = Date.now();
    const startedAtIso = new Date(startedAt).toISOString();
    return new Promise<RawRow[]>((resolve, reject) => {
      pending.set(id, {
        onStarted,
        resolve: (rows) => {
          logger.debug(logTag, {
            id,
            startedAt: startedAtIso,
            durationMs: Date.now() - startedAt,
            rows: rows.length,
            sql,
            ...extraLogFields,
          });
          resolve(rows);
        },
        reject: (err) => {
          logger.debug(`${logTag}-failed`, {
            id,
            startedAt: startedAtIso,
            durationMs: Date.now() - startedAt,
            error: err.message,
            sql,
            ...extraLogFields,
          });
          reject(err);
        },
      });
      worker.postMessage({ kind, id, sql, ...extraPayload });
    });
  }

  return {
    runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('query', sql, 'duckdb:query', {}, {}, onStarted);
    },
    runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]> {
      return submitQuery('prepared-query', sql, 'duckdb:prepared-query', { params }, { paramCount: params.length }, onStarted);
    },
    cancelPendingQueries(): void {
      worker.postMessage({ kind: 'cancel-pending' });
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}
