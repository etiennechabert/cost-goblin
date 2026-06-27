import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';

export type WorkerBackend = 'thread' | 'process';

export interface WorkerLifecycle<P> {
  readonly pending: Map<number, P>;
  nextId: number;
  fatalError: Error | null;
  /** Last config message; replayed after an auto-restart (process backend). */
  lastConfig: Record<string, unknown> | null;
  /** Send a message to the current worker. */
  post(msg: object): void;
  /** Register the steady-state message handler. It is re-attached automatically
   *  whenever the worker is replaced after a crash, so callers never see the
   *  restart. */
  setMessageHandler(handler: (msg: unknown) => void): void;
  /** Terminate the worker and disable auto-restart. */
  terminate(): Promise<void>;
}

/** Error message prefix used when the worker dies unexpectedly (typically a
 *  native OOM). UI code can match on this to show a friendly message. */
export const OOM_ERROR_PREFIX = 'Query used too much memory';

/** Transport abstraction over a worker thread or a forked child process — both
 *  expose message-passing + lifecycle events, but with different method names. */
interface WorkerHandle {
  send(msg: object): void;
  addMessageListener(listener: (msg: unknown) => void): void;
  removeMessageListener(listener: (msg: unknown) => void): void;
  onError(listener: (err: Error) => void): void;
  onceError(listener: (err: Error) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  terminate(): void;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

function makeThreadHandle(workerPath: string): WorkerHandle {
  const worker = new Worker(workerPath);
  return {
    send: (msg) => { worker.postMessage(msg); },
    addMessageListener: (l) => { worker.on('message', l); },
    removeMessageListener: (l) => { worker.off('message', l); },
    onError: (l) => { worker.on('error', (e: unknown) => { l(toError(e)); }); },
    onceError: (l) => { worker.once('error', (e: unknown) => { l(toError(e)); }); },
    onExit: (l) => { worker.on('exit', (code: number) => { l(code, null); }); },
    terminate: () => { void worker.terminate(); },
  };
}

function makeProcessHandle(workerPath: string): WorkerHandle {
  // fork() runs the bundle in a separate OS process with its own address space,
  // so a native OOM only kills the child — not the Electron app. Electron's
  // bundled binary is the exec path, so ELECTRON_RUN_AS_NODE is required to run
  // the script as plain Node (without it, fork relaunches Electron). 'advanced'
  // serialization preserves BigInt/Date over IPC, matching the structured clone
  // worker_threads gave us for free.
  const child = fork(workerPath, [], {
    serialization: 'advanced',
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return {
    send: (msg) => { child.send(msg); },
    addMessageListener: (l) => { child.on('message', l); },
    removeMessageListener: (l) => { child.off('message', l); },
    onError: (l) => { child.on('error', (e: unknown) => { l(toError(e)); }); },
    onceError: (l) => { child.once('error', (e: unknown) => { l(toError(e)); }); },
    onExit: (l) => { child.on('exit', (code, signal) => { l(code, signal); }); },
    terminate: () => { child.kill(); },
  };
}

export async function initWorkerLifecycle<P extends { reject: (err: Error) => void }>(
  workerPath: string,
  isReady: (msg: unknown) => boolean,
  isInitError: (msg: unknown) => string | null,
  options: { backend: WorkerBackend; autoRestart?: boolean },
): Promise<WorkerLifecycle<P>> {
  const pending = new Map<number, P>();
  const autoRestart = options.autoRestart ?? false;
  let terminated = false;
  let steadyHandler: ((msg: unknown) => void) | null = null;

  function spawn(): WorkerHandle {
    return options.backend === 'process' ? makeProcessHandle(workerPath) : makeThreadHandle(workerPath);
  }

  let handle = spawn();

  const state: WorkerLifecycle<P> = {
    pending,
    nextId: 0,
    fatalError: null,
    lastConfig: null,
    post(msg: object): void {
      handle.send(msg);
    },
    setMessageHandler(handler: (msg: unknown) => void): void {
      steadyHandler = handler;
      handle.addMessageListener(handler);
    },
    terminate(): Promise<void> {
      terminated = true;
      handle.terminate();
      return Promise.resolve();
    },
  };

  function rejectAllPending(err: Error): void {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  function attach(h: WorkerHandle): void {
    h.onError((err) => {
      state.fatalError = err;
      rejectAllPending(err);
    });
    h.onExit((code, signal) => {
      if (terminated || code === 0) return;
      const isCrash =
        code === null || signal === 'SIGKILL' || signal === 'SIGABRT' || signal === 'SIGTRAP';
      const message = isCrash
        ? `${OOM_ERROR_PREFIX} — the query engine was restarted automatically. Try narrowing your date range or disabling resource-level grouping.`
        : `Worker exited unexpectedly with code ${String(code)}`;
      const err = new Error(message);

      if (!autoRestart) {
        state.fatalError ??= err;
        rejectAllPending(err);
        return;
      }

      // In-flight queries can't be replayed (one of them likely caused the OOM),
      // so reject them; the next query runs on the fresh worker.
      rejectAllPending(err);

      const next = spawn();
      handle = next;
      state.fatalError = null;

      // Re-attach the client's handler so responses keep flowing transparently.
      if (steadyHandler !== null) next.addMessageListener(steadyHandler);

      // Replay the last configuration once the fresh worker reports ready, so it
      // comes up with the same memory limit / temp dir as before the crash.
      const onReady = (msg: unknown): void => {
        if (!isReady(msg)) return;
        next.removeMessageListener(onReady);
        if (state.lastConfig !== null) next.send(state.lastConfig);
      };
      next.addMessageListener(onReady);

      attach(next);
    });
  }

  const ready = new Promise<void>((resolve, reject) => {
    const onMessage = (msg: unknown): void => {
      if (isReady(msg)) {
        handle.removeMessageListener(onMessage);
        resolve();
        return;
      }
      const errMsg = isInitError(msg);
      if (errMsg !== null) {
        handle.removeMessageListener(onMessage);
        const err = new Error(errMsg);
        state.fatalError = err;
        reject(err);
      }
    };
    handle.addMessageListener(onMessage);
    handle.onceError((err) => {
      state.fatalError = err;
      reject(err);
    });
  });

  attach(handle);
  await ready;
  return state;
}
