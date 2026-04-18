import { Worker } from 'node:worker_threads';

export type RawRow = Readonly<Record<string, unknown>>;

export interface DuckDBClient {
  runQuery(sql: string): Promise<RawRow[]>;
  terminate(): Promise<void>;
}

type WorkerResponse =
  | { kind: 'ready' }
  | { kind: 'rows'; id: number; rows: RawRow[] }
  | { kind: 'error'; id: number; message: string };

function isWorkerResponse(msg: unknown): msg is WorkerResponse {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  if (m['kind'] === 'ready') return true;
  if ((m['kind'] === 'rows' || m['kind'] === 'error') && typeof m['id'] === 'number') {
    if (m['kind'] === 'rows') return Array.isArray(m['rows']);
    return typeof m['message'] === 'string';
  }
  return false;
}

interface PendingQuery {
  resolve: (rows: RawRow[]) => void;
  reject: (err: Error) => void;
}

export async function createDuckDBClient(workerPath: string): Promise<DuckDBClient> {
  const worker = new Worker(workerPath);
  const pending = new Map<number, PendingQuery>();
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
    pending.delete(msg.id);
    if (msg.kind === 'rows') entry.resolve(msg.rows);
    else entry.reject(new Error(msg.message));
  });

  worker.on('error', (err) => {
    fatalError = err;
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      const err = new Error(`DuckDB worker exited unexpectedly with code ${String(code)}`);
      fatalError ??= err;
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    }
  });

  await ready;

  return {
    runQuery(sql: string): Promise<RawRow[]> {
      if (fatalError !== null) return Promise.reject(fatalError);
      const id = nextId++;
      return new Promise<RawRow[]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        worker.postMessage({ kind: 'query', id, sql });
      });
    },
    async terminate(): Promise<void> {
      await worker.terminate();
    },
  };
}
