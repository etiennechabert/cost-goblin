import { QUERY_CANCELLED_MESSAGE, logger } from '@costgoblin/core';
import type { QueryEngineState } from '@costgoblin/core';
import { isWorkerResponse } from './duckdb-client.js';
import type { DuckDBClient, RawRow } from './duckdb-client.js';
import { DUCKDB_SETTINGS_ENV } from './duckdb-tuning.js';
import { ensureUvThreadpoolSize } from './uv-threadpool.js';

/**
 * Supervises the app's shared DuckDB instance, which runs in a process of its
 * own. A native failure in DuckDB (an allocator that runs out, an assertion,
 * a signal) ends that process and nothing else: the queries it was running
 * fail, a new process starts, and the app carries on.
 *
 * The rest of main sees a `DuckDBClient`, as it did when DuckDB was a worker
 * thread of the main process.
 */

/** Deaths inside {@link DEATH_WINDOW_MS} at which the process is no longer
 *  restarted.
 *
 *  One death can be anything, and a second can be the user running the same
 *  heavy query again, or a rollup build that needed two goes: the months a
 *  build finishes are kept, so each restart has less left to do. A third
 *  within the window means the same thing keeps killing it. Starting a fourth
 *  process would repeat the damage: every death fails all the queries in
 *  flight, and each restart starts the rollup build again, which may be what
 *  kills it. */
export const MAX_DEATHS = 3;

/** How far back deaths count. Long against the slowest things the app runs on
 *  its largest known workspace (a full rollup rebuild takes about a minute,
 *  the slowest raw dashboard query about two), so a loop driven by either one
 *  fits three deaths inside it. A window shorter than twice the time a loop
 *  takes to kill the process would never see a third death, and the loop
 *  would go on for ever. Deaths hours apart never add up. */
export const DEATH_WINDOW_MS = 10 * 60_000;

/** How long a new process may take to report ready. DuckDB starts in tens of
 *  milliseconds; a process that takes this long is not going to. Without the
 *  limit, the queries held for it would wait for ever. */
export const START_TIMEOUT_MS = 30_000;

/** How long `terminate` waits for the killed process to report its exit. */
export const TERMINATE_TIMEOUT_MS = 5_000;

const RESTARTING_MESSAGE = 'The query engine stopped unexpectedly and is restarting. Run the query again.';
const SHUT_DOWN_MESSAGE = 'The query engine was shut down.';

export interface DuckDBProcessExit {
  /** The exit code, when the host reports one: a signal number for a process
   *  a signal ended, 0 for one that was asked to end. */
  readonly code: number | null;
  /** The last of what the process wrote to stderr, for the log. */
  readonly stderrTail?: string | undefined;
}

/** One running copy of the DuckDB bundle, in a process of its own: an
 *  Electron utility process in the app (`duckdb-utility-process.ts`). */
export interface DuckDBProcess {
  readonly pid: number | undefined;
  postMessage(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** `listener` is called once the process has ended, however it ended. */
  onExit(listener: (exit: DuckDBProcessExit) => void): void;
  kill(): void;
}

/** What `DuckDBClient.configure` takes: the spill directory, the memory limit
 *  and the thread count. */
export type DuckDBSettings = Parameters<DuckDBClient['configure']>[0];

/** Starts a process that applies `settings` before it reports ready. */
export type SpawnDuckDBProcess = (settings: DuckDBSettings) => DuckDBProcess;

/**
 * The environment a host starts the DuckDB process with: `env` (the host's
 * own), plus the settings the bundle applies before it reports ready.
 *
 * It also carries the size of libuv's thread pool, which a process reads
 * once, at the pool's first use. A running query holds one pool thread until
 * it returns, and with libuv's default of four a rollup build could not start
 * while four queries ran, and every file read in the process waited behind
 * them. The main process sizes its own pool at startup
 * (`uv-threadpool-init.ts`) and that variable travels here in `env`; it is
 * set again when `env` lacks it, so the process never depends on that.
 */
export function duckdbProcessEnv(env: Readonly<Record<string, string | undefined>>, settings: DuckDBSettings): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) result[name] = value;
  }
  result[DUCKDB_SETTINGS_ENV] = JSON.stringify(settings);
  ensureUvThreadpoolSize(result);
  return result;
}

export interface SupervisedDuckDBClient extends DuckDBClient {
  getState(): QueryEngineState;
  /** `listener` is called on every change of state; read the current one with
   *  {@link getState}. Returns the unsubscribe function. */
  onStateChanged(listener: (state: QueryEngineState) => void): () => void;
  /** `listener` is called each time a new process has replaced one that
   *  ended, once it is configured and running: the moment to redo what the
   *  old process took with it. */
  onRestarted(listener: () => void): () => void;
  /** Start again after the breaker stopped the engine, with a clean count of
   *  deaths. Resolves once it runs; rejects if it stops again before it does.
   *  Does nothing while the engine runs or is already restarting. */
  restart(): Promise<void>;
}

export interface SupervisorOptions {
  readonly spawn: SpawnDuckDBProcess;
  /** What the first process starts with. Every later process starts with
   *  these, changed by whatever `configure` was told since. */
  readonly settings?: DuckDBSettings;
  /** The clock the breaker measures its window on. Defaults to `Date.now`. */
  readonly now?: () => number;
}

type Phase = 'starting' | 'running' | 'restarting' | 'stopped' | 'terminated';

interface PendingQuery {
  readonly message: Readonly<Record<string, unknown>>;
  /** A rollup partition build: a view's cancel leaves it alone. */
  readonly build: boolean;
  readonly onStarted: (() => void) | undefined;
  readonly resolve: (rows: RawRow[]) => void;
  readonly reject: (err: Error) => void;
  /** Sent to the current process. Otherwise it is held for the next one. */
  posted: boolean;
}

/** One process, from its spawn to its exit. */
interface Incarnation {
  readonly proc: DuckDBProcess;
  /** The settings it was spawned with. */
  readonly settings: DuckDBSettings;
  /** Its pid as last seen: a host may only know it once the process runs,
   *  and forget it once the process is gone, which is when the log needs it. */
  pid: number | undefined;
  ended: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
  /** Why it never became ready, when it said so or ran out of time. */
  failure: string | null;
}

interface Waiter {
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeExit(exit: DuckDBProcessExit, failure: string | null): string {
  const parts = [exit.code === null ? 'no exit code' : `exit code ${String(exit.code)}`];
  if (failure !== null) parts.push(failure);
  const tail = exit.stderrTail?.trim();
  if (tail !== undefined && tail.length > 0) parts.push(tail);
  return parts.join(': ');
}

/** The settings of `next` that are set, without the keys that are not. */
function definedSettings(next: DuckDBSettings): DuckDBSettings {
  return {
    ...(next.tempDir === undefined ? {} : { tempDir: next.tempDir }),
    ...(next.memoryGB === undefined ? {} : { memoryGB: next.memoryGB }),
    ...(next.threads === undefined ? {} : { threads: next.threads }),
  };
}

class DuckDBSupervisor implements SupervisedDuckDBClient {
  private readonly spawn: SpawnDuckDBProcess;
  private readonly now: () => number;

  private phase: Phase = 'starting';
  private state: QueryEngineState = { state: 'running', restartedAt: null };
  private current: Incarnation | null = null;
  private readonly pending = new Map<number, PendingQuery>();
  private nextId = 0;
  /** The settings to run under: the ones given at the start, changed by
   *  every `configure` since. Each new process is spawned with them. */
  private settings: DuckDBSettings;
  /** When the process died, for the deaths still inside the window. */
  private deaths: number[] = [];

  private readonly stateListeners = new Set<(state: QueryEngineState) => void>();
  private readonly restartListeners = new Set<() => void>();
  private firstStart: Waiter | null = null;
  private restartWaiters: Waiter[] = [];
  private terminateWaiters: (() => void)[] = [];

  constructor(options: SupervisorOptions) {
    this.spawn = options.spawn;
    this.settings = definedSettings(options.settings ?? {});
    this.now = options.now ?? Date.now;
  }

  /** Start the first process. Rejects when it does not become ready: nothing
   *  restarts a process that has never run, the caller reports the failure. */
  start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.firstStart = { resolve, reject };
      const failure = this.launch();
      if (failure !== null) this.failFirstStart(failure);
    });
  }

  // ---- DuckDBClient -------------------------------------------------------

  runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
    return this.submit({ kind: 'query', sql }, false, onStarted);
  }

  runBuildQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
    return this.submit({ kind: 'query', sql, fresh: true }, true, onStarted);
  }

  runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]> {
    return this.submit({ kind: 'prepared-query', sql, params }, false, onStarted);
  }

  cancelPendingQueries(): void {
    this.cancel(false);
  }

  cancelAllQueries(): void {
    this.cancel(true);
  }

  configure(settings: DuckDBSettings): void {
    const set = definedSettings(settings);
    // A new object each time: a process remembers the one it was spawned with.
    this.settings = { ...this.settings, ...set };
    if (this.phase !== 'running') return;
    // Both limits each time, the one this call left alone as it is remembered:
    // the process takes a limit the message leaves out back to its default,
    // and would then run under other settings than the process that replaces
    // it. The spill directory only when this call names it: DuckDB refuses to
    // set it again once it has spilled there.
    const { memoryGB, threads } = this.settings;
    this.post({
      kind: 'configure',
      ...(memoryGB === undefined ? {} : { memoryGB }),
      ...(threads === undefined ? {} : { threads }),
      ...set,
    });
  }

  terminate(): Promise<void> {
    if (this.phase === 'terminated') return Promise.resolve();
    this.phase = 'terminated';
    const shutDown = new Error(SHUT_DOWN_MESSAGE);
    this.failPending(() => true, shutDown);
    this.settleRestartWaiters(shutDown);

    const inc = this.current;
    if (inc === null) return Promise.resolve();
    this.clearStartTimer(inc);
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, TERMINATE_TIMEOUT_MS);
      this.terminateWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.kill(inc);
    });
  }

  // ---- Supervision --------------------------------------------------------

  getState(): QueryEngineState {
    return this.state;
  }

  onStateChanged(listener: (state: QueryEngineState) => void): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  onRestarted(listener: () => void): () => void {
    this.restartListeners.add(listener);
    return () => { this.restartListeners.delete(listener); };
  }

  restart(): Promise<void> {
    if (this.phase === 'terminated') return Promise.reject(new Error(SHUT_DOWN_MESSAGE));
    if (this.phase !== 'stopped') return Promise.resolve();
    this.deaths = [];
    return new Promise<void>((resolve, reject) => {
      this.restartWaiters.push({ resolve, reject });
      this.startReplacement();
    });
  }

  // ---- Internals ----------------------------------------------------------

  private submit(request: Readonly<Record<string, unknown>>, build: boolean, onStarted: (() => void) | undefined): Promise<RawRow[]> {
    if (this.phase === 'terminated') return Promise.reject(new Error(SHUT_DOWN_MESSAGE));
    if (this.phase === 'stopped') return Promise.reject(this.stoppedError());
    const id = this.nextId++;
    return new Promise<RawRow[]>((resolve, reject) => {
      const entry: PendingQuery = { message: { ...request, id }, build, onStarted, resolve, reject, posted: false };
      this.pending.set(id, entry);
      // While a replacement starts the query is held, and sent once it is ready.
      if (this.phase === 'running') this.send(entry);
    });
  }

  private send(entry: PendingQuery): void {
    entry.posted = true;
    this.post(entry.message);
  }

  /** A process that has just died can refuse the message before its exit is
   *  reported. The exit then settles whatever the message was for. */
  private post(message: Readonly<Record<string, unknown>>): void {
    try {
      this.current?.proc.postMessage(message);
    } catch (err: unknown) {
      logger.warn(`duckdb: the process did not take a message (${errorMessage(err)})`);
    }
  }

  private cancel(includeBuilds: boolean): void {
    if (this.phase === 'running') {
      this.post(includeBuilds ? { kind: 'cancel-pending', builds: true } : { kind: 'cancel-pending' });
      return;
    }
    // No process is running anything: only the queries held for the next one.
    this.failPending(entry => !entry.posted && (includeBuilds || !entry.build), new Error(QUERY_CANCELLED_MESSAGE));
  }

  private failPending(matches: (entry: PendingQuery) => boolean, err: Error): void {
    for (const [id, entry] of this.pending) {
      if (!matches(entry)) continue;
      this.pending.delete(id);
      entry.reject(err);
    }
  }

  private stoppedError(): Error {
    const minutes = String(DEATH_WINDOW_MS / 60_000);
    return new Error(
      `The query engine stopped ${String(this.deaths.length)} times in ${minutes} minutes and was not restarted. `
      + 'Restart it from the notice at the top of the window.',
    );
  }

  private setState(state: QueryEngineState): void {
    this.state = state;
    for (const listener of this.stateListeners) this.tell(() => { listener(state); });
  }

  /** Call a listener that is not this class's own. One that throws must not
   *  stop the transition it is told about: the other listeners, the restart
   *  waiters and the held queries all come after it. */
  private tell(call: () => void): void {
    try {
      call();
    } catch (err: unknown) {
      logger.error(`duckdb: a listener of the query engine failed (${errorMessage(err)})`);
    }
  }

  private settleRestartWaiters(err: Error | null): void {
    const waiters = this.restartWaiters;
    this.restartWaiters = [];
    for (const waiter of waiters) {
      if (err === null) waiter.resolve();
      else waiter.reject(err);
    }
  }

  /** Spawn a process and listen to it. Returns why it could not be spawned,
   *  or null. */
  private launch(): string | null {
    const settings = this.settings;
    let proc: DuckDBProcess;
    try {
      proc = this.spawn(settings);
    } catch (err: unknown) {
      return errorMessage(err);
    }
    const inc: Incarnation = { proc, settings, pid: proc.pid, ended: false, startTimer: null, failure: null };
    this.current = inc;
    proc.onMessage((message) => { this.onMessage(inc, message); });
    proc.onExit((exit) => { this.onExit(inc, exit); });
    inc.startTimer = setTimeout(() => {
      inc.startTimer = null;
      this.onStartFailure(inc, `not ready after ${String(START_TIMEOUT_MS / 1000)} seconds`);
    }, START_TIMEOUT_MS);
    return null;
  }

  private clearStartTimer(inc: Incarnation): void {
    if (inc.startTimer !== null) clearTimeout(inc.startTimer);
    inc.startTimer = null;
  }

  private kill(inc: Incarnation): void {
    try {
      inc.proc.kill();
    } catch (err: unknown) {
      logger.warn(`duckdb: could not kill the process (${errorMessage(err)})`);
    }
  }

  private onMessage(inc: Incarnation, message: unknown): void {
    // A process that has been replaced has nothing left to say.
    if (this.current !== inc || inc.ended || !isWorkerResponse(message)) return;
    const startingUp = this.phase === 'starting' || this.phase === 'restarting';
    if (message.kind === 'ready') {
      if (startingUp) this.onReady(inc);
      return;
    }
    if (message.kind === 'started') {
      this.pending.get(message.id)?.onStarted?.();
      return;
    }
    if (message.kind === 'error' && message.id === -1) {
      if (startingUp) this.onStartFailure(inc, message.message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (entry === undefined) return;
    this.pending.delete(message.id);
    if (message.kind === 'rows') entry.resolve(message.rows);
    else entry.reject(new Error(message.message));
  }

  private onReady(inc: Incarnation): void {
    this.clearStartTimer(inc);
    inc.pid = inc.proc.pid ?? inc.pid;
    const replacement = this.phase === 'restarting';
    this.phase = 'running';
    // The process applied the settings it was spawned with before it said
    // ready. Only a `configure` made while it started is still owed to it.
    if (inc.settings !== this.settings) this.post({ kind: 'configure', ...this.settings });
    for (const entry of this.pending.values()) {
      if (!entry.posted) this.send(entry);
    }
    if (!replacement) {
      const starting = this.firstStart;
      this.firstStart = null;
      starting?.resolve();
      return;
    }
    logger.info('duckdb: the query engine is running again', { pid: inc.pid });
    this.setState({ state: 'running', restartedAt: this.now() });
    for (const listener of this.restartListeners) this.tell(listener);
    this.settleRestartWaiters(null);
  }

  /** The process said it cannot start, or took too long to say anything. */
  private onStartFailure(inc: Incarnation, reason: string): void {
    this.clearStartTimer(inc);
    inc.failure = reason;
    if (this.phase === 'starting') {
      this.failFirstStart(reason);
      this.kill(inc);
      return;
    }
    // A replacement: given up on now, a death like any other. Not once it
    // exits: a process stuck this badly may never report that, and the
    // queries held for it would wait for ever. Whatever it still says, its
    // exit included, is ignored from here on.
    inc.ended = true;
    this.current = null;
    this.kill(inc);
    logger.error('duckdb: the new query engine process did not start', { pid: inc.proc.pid ?? inc.pid, reason });
    this.onDeath();
  }

  private failFirstStart(reason: string): void {
    const starting = this.firstStart;
    this.firstStart = null;
    this.phase = 'terminated';
    starting?.reject(new Error(`The query engine could not start: ${reason}`));
  }

  private onExit(inc: Incarnation, exit: DuckDBProcessExit): void {
    if (inc.ended) return;
    inc.ended = true;
    this.clearStartTimer(inc);
    if (this.current !== inc) return;
    this.current = null;

    if (this.phase === 'terminated') {
      const waiters = this.terminateWaiters;
      this.terminateWaiters = [];
      for (const done of waiters) done();
      return;
    }
    const detail = describeExit(exit, inc.failure);
    if (this.phase === 'starting') {
      this.failFirstStart(`it exited before it was ready (${detail})`);
      return;
    }
    // Any exit nobody asked for, whatever its code.
    logger.error('duckdb: the query engine process ended unexpectedly', { pid: inc.proc.pid ?? inc.pid, exit: detail });
    this.onDeath();
  }

  /** Count a death, then either start a replacement or stop for good. */
  private onDeath(): void {
    const now = this.now();
    this.deaths = [...this.deaths.filter(at => now - at < DEATH_WINDOW_MS), now];
    if (this.deaths.length >= MAX_DEATHS) {
      this.stop();
      return;
    }
    // What the dead process was running is lost. What is held waits on.
    this.failPending(entry => entry.posted, new Error(RESTARTING_MESSAGE));
    this.startReplacement();
  }

  private startReplacement(): void {
    if (this.phase !== 'restarting') {
      this.phase = 'restarting';
      this.setState({ state: 'restarting' });
    }
    const failure = this.launch();
    if (failure === null) return;
    // A process that cannot even be spawned is a death like the others, so a
    // host that keeps refusing ends at the breaker instead of spinning here.
    logger.error(`duckdb: could not start the query engine process (${failure})`);
    this.onDeath();
  }

  private stop(): void {
    this.phase = 'stopped';
    const err = this.stoppedError();
    logger.error(`duckdb: ${err.message}`);
    // Nothing will run these: not the ones in flight, not the ones held.
    this.failPending(() => true, err);
    this.setState({ state: 'stopped', deaths: this.deaths.length, windowMinutes: DEATH_WINDOW_MS / 60_000 });
    this.settleRestartWaiters(err);
  }
}

/** Start the app's DuckDB process and supervise it. Rejects when the first
 *  process does not start. */
export async function createSupervisedDuckDBClient(options: SupervisorOptions): Promise<SupervisedDuckDBClient> {
  const supervisor = new DuckDBSupervisor(options);
  await supervisor.start();
  return supervisor;
}
