import { fork } from 'node:child_process';
import { Worker } from 'node:worker_threads';

export type WorkerBackend = 'thread' | 'process';

export interface WorkerLifecycle<P> {
  readonly pending: Map<number, P>;
  nextId: number;
  fatalError: Error | null;
  /** Last config message; merged across calls and replayed after a restart. */
  lastConfig: Record<string, unknown> | null;
  /** Send a message to the current worker. While a (re)start is in flight the
   *  message is queued and flushed, in order, once the worker is ready +
   *  configured — so a query never races ahead of the replayed `configure`. */
  post(msg: object): void;
  /** Register the steady-state message handler. Re-attached automatically to the
   *  replacement worker after a restart, so callers never see the swap. */
  setMessageHandler(handler: (msg: unknown) => void): void;
  /** Terminate the worker and disable auto-restart. */
  terminate(): Promise<void>;
}

/** Error message prefix used when the worker dies unexpectedly (typically a
 *  native OOM). UI code can match on this to show a friendly message. */
export const OOM_ERROR_PREFIX = 'Query used too much memory';

/** Give up auto-restarting after this many consecutive failures to come up — a
 *  persistently-crashing child (bad config, missing binary) must not spin a
 *  fork bomb. Reset to 0 the moment a child reports ready. */
const MAX_CONSECUTIVE_RESTARTS = 5;
/** Delay before each restart attempt — avoids a tight CPU loop and gives a
 *  momentarily-starved machine a beat to free memory. */
const RESTART_DELAY_MS = 250;

/** Transport over a worker thread or a forked child process — both pass messages
 *  and emit lifecycle events, but with different method names. */
interface WorkerHandle {
  send(msg: object): void;
  addMessageListener(listener: (msg: unknown) => void): void;
  removeMessageListener(listener: (msg: unknown) => void): void;
  onError(listener: (err: Error) => void): void;
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
    onExit: (l) => { worker.on('exit', (code: number) => { l(code, null); }); },
    terminate: () => { void worker.terminate(); },
  };
}

function makeProcessHandle(workerPath: string): WorkerHandle {
  // fork() runs the bundle in a separate OS process with its own address space,
  // so a native OOM only kills the child. Electron's bundled binary is the exec
  // path, so ELECTRON_RUN_AS_NODE is required to run the script as plain Node
  // (without it, fork relaunches Electron). 'advanced' serialization preserves
  // BigInt/Date over IPC, matching the structured clone worker_threads gave for
  // free.
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
    onExit: (l) => { child.on('exit', (code, signal) => { l(code, signal); }); },
    terminate: () => { child.kill(); },
  };
}

function crashMessage(code: number | null, signal: string | null): string {
  const isCrash = code === null || signal === 'SIGKILL' || signal === 'SIGABRT' || signal === 'SIGTRAP';
  return isCrash
    ? `${OOM_ERROR_PREFIX} — the query engine was restarted automatically. Try narrowing your date range or disabling resource-level grouping.`
    : `Worker exited unexpectedly with code ${String(code)}`;
}

export async function initWorkerLifecycle<P extends { reject: (err: Error) => void }>(
  workerPath: string,
  isReady: (msg: unknown) => boolean,
  isInitError: (msg: unknown) => string | null,
  options: { backend: WorkerBackend; autoRestart?: boolean },
): Promise<WorkerLifecycle<P>> {
  const pending = new Map<number, P>();
  const autoRestart = options.autoRestart ?? false;

  let handle: WorkerHandle | null = null; // current handle (null only before first spawn)
  let terminated = false;
  let accepting = false;                   // current handle is ready + configured
  let consecutiveFailures = 0;
  let steadyHandler: ((msg: unknown) => void) | null = null;
  const outbox: object[] = [];             // queued while a (re)start is in flight

  function spawn(): WorkerHandle {
    return options.backend === 'process' ? makeProcessHandle(workerPath) : makeThreadHandle(workerPath);
  }

  function rejectAllPending(err: Error): void {
    for (const entry of pending.values()) entry.reject(err);
    pending.clear();
  }

  const state: WorkerLifecycle<P> = {
    pending,
    nextId: 0,
    fatalError: null,
    lastConfig: null,
    post(msg: object): void {
      if (accepting && handle !== null) handle.send(msg);
      else outbox.push(msg);
    },
    setMessageHandler(h: (msg: unknown) => void): void {
      steadyHandler = h;
      if (handle !== null) handle.addMessageListener(h);
    },
    terminate(): Promise<void> {
      terminated = true;
      accepting = false;
      if (handle !== null) handle.terminate();
      return Promise.resolve();
    },
  };

  function giveUp(reason: Error): void {
    state.fatalError = reason;
    rejectAllPending(reason);
    outbox.length = 0;
  }

  // Restart after a post-ready crash. Bounded + delayed so a child that crashes
  // on every spawn can't spin a fork bomb; a successful bring-up resets the count.
  function scheduleRestart(): void {
    if (terminated) return;
    consecutiveFailures += 1;
    if (consecutiveFailures > MAX_CONSECUTIVE_RESTARTS) {
      giveUp(new Error(
        `${OOM_ERROR_PREFIX} — the query engine keeps crashing on restart and has been stopped. Please restart the app.`,
      ));
      return;
    }
    setTimeout(() => {
      if (terminated) return;
      bringUp().catch(() => { scheduleRestart(); });
    }, RESTART_DELAY_MS);
  }

  // Spawn a handle and wire listeners scoped to THAT handle (a stale, dead
  // handle's late error/exit events are ignored). Resolves when it reports
  // ready (after replaying config + flushing queued messages); rejects on an
  // init error or a pre-ready crash. Used for both the initial start and every
  // restart.
  function bringUp(): Promise<void> {
    const h = spawn();
    handle = h;
    accepting = false;
    let settled = false; // bringUp promise settled (ready or failed)
    let crashed = false; // this handle already routed an error/exit

    return new Promise<void>((resolve, reject) => {
      const onMessage = (msg: unknown): void => {
        if (isReady(msg)) {
          settled = true;
          h.removeMessageListener(onMessage);
          consecutiveFailures = 0;
          state.fatalError = null;
          if (steadyHandler !== null) h.addMessageListener(steadyHandler);
          if (state.lastConfig !== null) h.send(state.lastConfig); // config first…
          accepting = true;
          for (const m of outbox) h.send(m);                        // …then queued work
          outbox.length = 0;
          resolve();
          return;
        }
        const errMsg = isInitError(msg);
        if (errMsg !== null) {
          settled = true;
          crashed = true;
          h.removeMessageListener(onMessage);
          reject(new Error(errMsg));
        }
      };

      const handleCrash = (err: Error): void => {
        if (h !== handle || crashed) return; // stale handle or already handled
        crashed = true;
        accepting = false;
        rejectAllPending(err);
        if (!settled) {
          settled = true;
          h.removeMessageListener(onMessage);
          reject(err);            // pre-ready failure → fail this bring-up attempt
          return;
        }
        if (autoRestart) scheduleRestart(); // post-ready crash → restart
        else state.fatalError = err;        // no restart (sync worker) → fatal
      };

      h.addMessageListener(onMessage);
      h.onError(handleCrash);
      h.onExit((code, signal) => {
        if (terminated || code === 0) return;
        handleCrash(new Error(crashMessage(code, signal)));
      });
    });
  }

  // Initial start: a pre-ready crash / init error rejects and is surfaced to the
  // caller — we do NOT silently restart-loop before the worker has ever come up.
  // Once it is ready, later crashes auto-restart (when enabled).
  await bringUp();
  return state;
}
