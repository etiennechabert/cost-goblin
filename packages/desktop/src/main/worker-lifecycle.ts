import { Worker } from 'node:worker_threads';

export interface WorkerLifecycle<P> {
  readonly worker: Worker;
  readonly pending: Map<number, P>;
  nextId: number;
  fatalError: Error | null;
}

/** Spawn a worker and wait for its ready message. `workerData`, when given, is
 *  structured-cloned into the worker (`node:worker_threads` `workerData`). If
 *  init fails the worker is terminated before the rejection propagates, so a
 *  failed start never leaves a thread (and its DuckDB instance) behind. */
export async function initWorkerLifecycle<P extends { reject: (err: Error) => void }>(
  workerPath: string,
  isReady: (msg: unknown) => boolean,
  isInitError: (msg: unknown) => string | null,
  workerData?: unknown,
): Promise<WorkerLifecycle<P>> {
  const worker = workerData === undefined ? new Worker(workerPath) : new Worker(workerPath, { workerData });
  const pending = new Map<number, P>();
  const state: WorkerLifecycle<P> = { worker, pending, nextId: 0, fatalError: null };

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: unknown): void => {
      if (isReady(msg)) {
        worker.off('message', onMessage);
        resolve();
        return;
      }
      const errMsg = isInitError(msg);
      if (errMsg !== null) {
        worker.off('message', onMessage);
        const err = new Error(errMsg);
        state.fatalError = err;
        reject(err);
      }
    };
    worker.on('message', onMessage);
    worker.once('error', (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      state.fatalError = err;
      reject(err);
    });
  });

  worker.on('error', (e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    state.fatalError = err;
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  });

  worker.on('exit', (code) => {
    if (code !== 0) {
      const err = new Error(`Worker exited unexpectedly with code ${String(code)}`);
      state.fatalError ??= err;
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
    }
  });

  try {
    await ready;
  } catch (err: unknown) {
    await worker.terminate().catch(() => undefined);
    throw err;
  }
  return state;
}
