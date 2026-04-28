import { Worker } from 'node:worker_threads';

export interface WorkerLifecycle<P> {
  readonly worker: Worker;
  readonly pending: Map<number, P>;
  nextId: number;
  fatalError: Error | null;
}

export async function initWorkerLifecycle<P extends { reject: (err: Error) => void }>(
  workerPath: string,
  isReady: (msg: unknown) => boolean,
  isInitError: (msg: unknown) => string | null,
): Promise<WorkerLifecycle<P>> {
  const worker = new Worker(workerPath);
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

  await ready;
  return state;
}
