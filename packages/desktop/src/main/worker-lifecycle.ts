import { type ChildProcess, fork } from 'node:child_process';

export interface WorkerLifecycle<P> {
  readonly worker: ChildProcess;
  readonly pending: Map<number, P>;
  nextId: number;
  fatalError: Error | null;
  /** Last configuration message, replayed on auto-restart. */
  lastConfig: Record<string, unknown> | null;
  /** Whether the lifecycle has been explicitly terminated (no auto-restart). */
  terminated: boolean;
}

/** OOM-safe error message prefix used when the child process dies unexpectedly.
 *  UI code can check for this to show a user-friendly message. */
export const OOM_ERROR_PREFIX = 'Query used too much memory';

/**
 * Spawn a DuckDB child process (instead of a worker thread) so that a native
 * OOM crash only kills the child — not the entire Electron app.  The child
 * auto-restarts on unexpected exit and replays the last `configure` message.
 */
export async function initWorkerLifecycle<P extends { reject: (err: Error) => void }>(
  workerPath: string,
  isReady: (msg: unknown) => boolean,
  isInitError: (msg: unknown) => string | null,
): Promise<WorkerLifecycle<P>> {
  const pending = new Map<number, P>();

  function spawnChild(): ChildProcess {
    // fork() gives us the same postMessage/on('message') IPC as worker_threads
    // but in a separate OS process with its own address space.
    return fork(workerPath, [], {
      serialization: 'advanced',
      stdio: 'inherit',
    });
  }

  let child = spawnChild();
  const state: WorkerLifecycle<P> = {
    worker: child,
    pending,
    nextId: 0,
    fatalError: null,
    lastConfig: null,
    terminated: false,
  };

  // Wait for the initial 'ready' message from the child.
  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: unknown): void => {
      if (isReady(msg)) {
        child.off('message', onMessage);
        resolve();
        return;
      }
      const errMsg = isInitError(msg);
      if (errMsg !== null) {
        child.off('message', onMessage);
        const err = new Error(errMsg);
        state.fatalError = err;
        reject(err);
      }
    };
    child.on('message', onMessage);
    child.once('error', (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      state.fatalError = err;
      reject(err);
    });
  });

  function rejectAllPending(err: Error): void {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  function attachErrorHandlers(proc: ChildProcess): void {
    proc.on('error', (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      state.fatalError = err;
      rejectAllPending(err);
    });

    proc.on('exit', (code, signal) => {
      if (state.terminated) return;
      if (code !== 0) {
        const isOOM = signal === 'SIGKILL' || signal === 'SIGABRT' || signal === 'SIGTRAP' || code === null;
        const msg = isOOM
          ? `${OOM_ERROR_PREFIX} — the query engine was restarted automatically. Try narrowing your date range or disabling resource-level grouping.`
          : `Worker exited unexpectedly with code ${String(code)}`;
        const err = new Error(msg);

        // Reject all in-flight queries
        rejectAllPending(err);

        // Auto-restart the child process
        const newChild = spawnChild();
        // Replace the worker reference. The property is readonly on the
        // interface but we need to mutate it internally.
        (state as { worker: ChildProcess }).worker = newChild;
        child = newChild;
        state.fatalError = null;

        // Wait for the new child to be ready, then replay config.
        const restartReady = new Promise<void>((resolve) => {
          const onMsg = (m: unknown): void => {
            if (isReady(m)) {
              newChild.off('message', onMsg);
              resolve();
            }
          };
          newChild.on('message', onMsg);
        });

        restartReady
          .then(() => {
            if (state.lastConfig !== null) {
              newChild.send(state.lastConfig);
            }
          })
          .catch(() => undefined);

        attachErrorHandlers(newChild);
      }
    });
  }

  attachErrorHandlers(child);

  await ready;
  return state;
}
