import { afterEach, describe, expect, it, vi } from 'vitest';
import { QUERY_CANCELLED_MESSAGE, logger } from '@costgoblin/core';
import type { QueryEngineState } from '@costgoblin/core';
import {
  createSupervisedDuckDBClient,
  DEATH_WINDOW_MS,
  duckdbProcessEnv,
  MAX_DEATHS,
  START_TIMEOUT_MS,
  TERMINATE_TIMEOUT_MS,
} from '../main/duckdb-supervisor.js';
import type { DuckDBProcess, DuckDBProcessExit, DuckDBSettings, SupervisedDuckDBClient } from '../main/duckdb-supervisor.js';
import { DUCKDB_SETTINGS_ENV } from '../main/duckdb-tuning.js';
import { uvThreadpoolSize } from '../main/uv-threadpool.js';

/** The supervisor of the app's DuckDB process, against a stand-in process the
 *  test drives: it says what the process says, and ends it when the test
 *  wants it dead. The real process is covered by
 *  duckdb-process.integration.test.ts. */

class FakeProcess implements DuckDBProcess {
  /** Undefined before the process runs and after it is gone, as a utility
   *  process reports it. */
  pid: number | undefined;
  readonly posted: unknown[] = [];
  kills = 0;
  private readonly messageListeners: ((message: unknown) => void)[] = [];
  private readonly exitListeners: ((exit: DuckDBProcessExit) => void)[] = [];

  constructor(pid: number | undefined) { this.pid = pid; }

  postMessage(message: unknown): void { this.posted.push(message); }
  onMessage(listener: (message: unknown) => void): void { this.messageListeners.push(listener); }
  onExit(listener: (exit: DuckDBProcessExit) => void): void { this.exitListeners.push(listener); }
  kill(): void { this.kills += 1; }

  say(message: unknown): void { for (const listener of this.messageListeners) listener(message); }
  ready(): void { this.say({ kind: 'ready' }); }
  /** End the process the way a native abort does: no goodbye, just an exit. */
  die(exit: DuckDBProcessExit = { code: 6 }): void { for (const listener of this.exitListeners) listener(exit); }
}

interface Rig {
  readonly spawned: FakeProcess[];
  /** The settings each process was started with, in order. */
  readonly startedWith: DuckDBSettings[];
  readonly spawn: (settings: DuckDBSettings) => FakeProcess;
  readonly states: QueryEngineState[];
  /** The process started last. */
  current(): FakeProcess;
  clock: number;
}

function rig(): Rig {
  const spawned: FakeProcess[] = [];
  const startedWith: DuckDBSettings[] = [];
  const r: Rig = {
    spawned,
    startedWith,
    spawn: (settings) => {
      const proc = new FakeProcess(1000 + spawned.length);
      spawned.push(proc);
      startedWith.push(settings);
      return proc;
    },
    states: [],
    current: () => {
      const proc = spawned.at(-1);
      if (proc === undefined) throw new Error('no process was started');
      return proc;
    },
    clock: Date.parse('2026-11-14T10:00:00Z'),
  };
  return r;
}

async function started(r: Rig, settings?: DuckDBSettings): Promise<SupervisedDuckDBClient> {
  const creating = createSupervisedDuckDBClient({ spawn: r.spawn, now: () => r.clock, ...(settings === undefined ? {} : { settings }) });
  r.current().ready();
  const client = await creating;
  client.onStateChanged((state) => { r.states.push(state); });
  return client;
}

/** Has `promise` settled yet (after letting queued callbacks run)? */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => { setImmediate(resolve); });
  return settled;
}

/** The rejection's message, or the reason it did not reject. */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'resolved';
  } catch (err: unknown) {
    return err instanceof Error ? err.message : `threw ${String(err)}`;
  }
}

afterEach(() => { vi.useRealTimers(); });

describe('starting the DuckDB process', () => {
  it('starts one process and is ready when it says so', async () => {
    const r = rig();
    const creating = createSupervisedDuckDBClient({ spawn: r.spawn, now: () => r.clock });
    expect(r.spawned).toHaveLength(1);
    expect(await isSettled(creating)).toBe(false);

    r.current().ready();
    const client = await creating;
    expect(client.getState()).toEqual({ state: 'running', restartedAt: null });
    expect(r.spawned).toHaveLength(1);
    expect(r.startedWith).toEqual([{}]);
  });

  it('starts the first process with the settings it is given, and sends it none', async () => {
    const r = rig();
    await started(r, { tempDir: '/ws/tmp', memoryGB: 4, threads: 8 });

    expect(r.startedWith).toEqual([{ tempDir: '/ws/tmp', memoryGB: 4, threads: 8 }]);
    // It applied them before it said ready: nothing to tell it again.
    expect(r.current().posted).toEqual([]);
  });

  it('fails creation, without a second attempt, when the first process exits before it is ready', async () => {
    const r = rig();
    const creating = createSupervisedDuckDBClient({ spawn: r.spawn, now: () => r.clock });
    r.current().die({ code: 1, stderrTail: 'Error: Cannot find module @duckdb/node-bindings-darwin-arm64' });

    const message = await rejection(creating);
    expect(message).toContain('exit code 1');
    expect(message).toContain('Cannot find module @duckdb/node-bindings-darwin-arm64');
    expect(r.spawned).toHaveLength(1);
  });

  it('fails creation with the reason the process gave for not starting', async () => {
    const r = rig();
    const creating = createSupervisedDuckDBClient({ spawn: r.spawn, now: () => r.clock });
    r.current().say({ kind: 'error', id: -1, message: 'DuckDB worker init failed: IO Error: disk full' });

    await expect(creating).rejects.toThrow('DuckDB worker init failed: IO Error: disk full');
    expect(r.current().kills).toBe(1);
    // Its exit, when it comes, starts nothing.
    r.current().die({ code: 0 });
    expect(r.spawned).toHaveLength(1);
  });

  it('fails creation when the process cannot be started at all', async () => {
    const creating = createSupervisedDuckDBClient({ spawn: () => { throw new Error('utilityProcess cannot be created before app is ready'); } });
    await expect(creating).rejects.toThrow('utilityProcess cannot be created before app is ready');
  });

  it('gives up on a first process that never says it is ready', async () => {
    vi.useFakeTimers();
    const r = rig();
    const creating = createSupervisedDuckDBClient({ spawn: r.spawn, now: () => r.clock });
    const failed = rejection(creating);

    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS - 1);
    expect(r.current().kills).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(await failed).toContain(`not ready after ${String(START_TIMEOUT_MS / 1000)} seconds`);
    expect(r.current().kills).toBe(1);
  });
});

describe('running queries', () => {
  it('posts each kind of query and resolves it with the rows the process returns', async () => {
    const r = rig();
    const client = await started(r);
    const proc = r.current();
    const startedQueries: string[] = [];

    const plain = client.runQuery('SELECT 1', () => { startedQueries.push('plain'); });
    const build = client.runBuildQuery('COPY x TO y');
    const prepared = client.runPreparedQuery('SELECT $1', ['a']);

    expect(proc.posted).toEqual([
      { kind: 'query', id: 0, sql: 'SELECT 1' },
      { kind: 'query', id: 1, sql: 'COPY x TO y', fresh: true },
      { kind: 'prepared-query', id: 2, sql: 'SELECT $1', params: ['a'] },
    ]);

    proc.say({ kind: 'started', id: 0 });
    proc.say({ kind: 'started', id: 1 });
    expect(startedQueries).toEqual(['plain']);

    proc.say({ kind: 'rows', id: 0, rows: [{ n: 1 }] });
    proc.say({ kind: 'rows', id: 1, rows: [] });
    proc.say({ kind: 'error', id: 2, message: 'Binder Error: no such column' });
    await expect(plain).resolves.toEqual([{ n: 1 }]);
    await expect(build).resolves.toEqual([]);
    await expect(prepared).rejects.toThrow('Binder Error: no such column');
  });

  it('ignores malformed messages and answers for requests it never sent', async () => {
    const r = rig();
    const client = await started(r);
    const proc = r.current();
    const query = client.runQuery('SELECT 2');

    for (const msg of [
      null,
      'rows',
      { kind: 'rows', id: 0, rows: 'not rows' },
      { kind: 'error', id: 0 },
      { kind: 'started' },
      { kind: 'mystery', id: 0 },
      { kind: 'ready' },
      { kind: 'started', id: 99 },
      { kind: 'rows', id: 99, rows: [] },
      // Only a process that is still starting can fail to start.
      { kind: 'error', id: -1, message: 'late init failure' },
    ]) proc.say(msg);
    expect(await isSettled(query)).toBe(false);
    expect(proc.kills).toBe(0);

    proc.say({ kind: 'rows', id: 0, rows: [{ ok: true }] });
    await expect(query).resolves.toEqual([{ ok: true }]);
  });

  it('forwards both cancels and the configuration', async () => {
    const r = rig();
    const client = await started(r);

    client.cancelPendingQueries();
    client.cancelAllQueries();
    client.configure({ tempDir: '/tmp/duck', memoryGB: 4, threads: 2 });

    expect(r.current().posted).toEqual([
      // A view's cancel names no builds: the process spares them.
      { kind: 'cancel-pending' },
      { kind: 'cancel-pending', builds: true },
      { kind: 'configure', tempDir: '/tmp/duck', memoryGB: 4, threads: 2 },
    ]);
  });

  it('keeps a query pending when the process cannot be reached, until its exit says why', async () => {
    const r = rig();
    const client = await started(r);
    const proc = r.current();
    // What a host does between a process's death and the exit it reports.
    vi.spyOn(proc, 'postMessage').mockImplementation(() => { throw new Error('channel closed'); });

    const query = client.runQuery('SELECT 1');
    client.cancelPendingQueries();
    client.configure({ threads: 2 });
    expect(await isSettled(query)).toBe(false);

    proc.die();
    await expect(query).rejects.toThrow(/stopped unexpectedly/);
  });
});

describe('when the process exits unexpectedly', () => {
  it('fails the queries it was running, saying what happened and what to do', async () => {
    const r = rig();
    const client = await started(r);
    const query = client.runQuery('SELECT 1');
    const prepared = client.runPreparedQuery('SELECT $1', [1]);
    const build = client.runBuildQuery('COPY x TO y');

    r.current().die({ code: 5 });

    const message = await rejection(query);
    expect(message).toBe('The query engine stopped unexpectedly and is restarting. Run the query again.');
    expect(await rejection(prepared)).toBe(message);
    expect(await rejection(build)).toBe(message);
  });

  it('starts a new process and runs the next query on it', async () => {
    const r = rig();
    const client = await started(r);
    const lost = client.runQuery('SELECT 1');
    r.current().die();
    await expect(lost).rejects.toThrow();

    expect(r.spawned).toHaveLength(2);
    const next = client.runQuery('SELECT 2');
    // Held, not failed and not sent to a process that is not ready.
    expect(r.current().posted).toEqual([]);
    expect(await isSettled(next)).toBe(false);

    r.current().ready();
    expect(r.current().posted).toEqual([{ kind: 'query', id: 1, sql: 'SELECT 2' }]);
    r.current().say({ kind: 'rows', id: 1, rows: [{ n: 2 }] });
    await expect(next).resolves.toEqual([{ n: 2 }]);
  });

  it('starts the new process with the settings the old one had, changes included', async () => {
    const r = rig();
    const client = await started(r, { tempDir: '/ws/tmp', memoryGB: 4, threads: 8 });
    // A later change of some settings leaves the others as they were.
    client.configure({ memoryGB: 2, threads: 4 });
    expect(r.current().posted).toEqual([{ kind: 'configure', memoryGB: 2, threads: 4 }]);

    r.current().die();
    const held = client.runBuildQuery('COPY x TO y');
    r.current().ready();

    expect(r.startedWith.at(-1)).toEqual({ tempDir: '/ws/tmp', memoryGB: 2, threads: 4 });
    // Started with them, so not sent them: the held query goes straight in,
    // to a process that already spills where it should.
    expect(r.current().posted).toEqual([{ kind: 'query', id: 0, sql: 'COPY x TO y', fresh: true }]);
    r.current().say({ kind: 'rows', id: 0, rows: [] });
    await expect(held).resolves.toEqual([]);
  });

  it('starts a process that was never configured with no settings', async () => {
    const r = rig();
    await started(r);
    r.current().die();
    r.current().ready();
    expect(r.startedWith).toEqual([{}, {}]);
    expect(r.current().posted).toEqual([]);
  });

  it('sends a configuration made while the new process started, ahead of the held queries', async () => {
    const r = rig();
    const client = await started(r, { tempDir: '/ws/tmp', threads: 8 });
    r.current().die();
    const held = client.runQuery('SELECT 1');

    // Too late for the process already starting: it was spawned without it.
    client.configure({ threads: 3 });
    expect(r.startedWith.at(-1)).toEqual({ tempDir: '/ws/tmp', threads: 8 });
    expect(r.current().posted).toEqual([]);

    r.current().ready();
    expect(r.current().posted).toEqual([
      { kind: 'configure', tempDir: '/ws/tmp', threads: 3 },
      { kind: 'query', id: 0, sql: 'SELECT 1' },
    ]);
    r.current().say({ kind: 'rows', id: 0, rows: [] });
    await held;

    // And the process after that one starts with it.
    r.current().die();
    expect(r.startedWith.at(-1)).toEqual({ tempDir: '/ws/tmp', threads: 3 });
  });

  it('names the process that died in the log, though the host has forgotten its pid by then', async () => {
    const r = rig();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      await started(r);
      const proc = r.current();
      // A utility process has no pid once its exit event is out.
      proc.pid = undefined;
      proc.die({ code: 9, stderrTail: 'Killed' });

      expect(error).toHaveBeenCalledWith(
        'duckdb: the query engine process ended unexpectedly',
        expect.objectContaining({ pid: 1000 }),
      );
    } finally {
      error.mockRestore();
    }
  });

  it('reports restarting, then running with the time it came back, and says it restarted once', async () => {
    const r = rig();
    const client = await started(r);
    const restarts: QueryEngineState[] = [];
    client.onRestarted(() => { restarts.push(client.getState()); });

    r.current().die();
    expect(client.getState()).toEqual({ state: 'restarting' });
    expect(restarts).toEqual([]);

    r.clock += 80;
    r.current().ready();
    const running: QueryEngineState = { state: 'running', restartedAt: r.clock };
    expect(r.states).toEqual([{ state: 'restarting' }, running]);
    // Told after the state changed, so a listener that re-warms sees `running`.
    expect(restarts).toEqual([running]);
  });

  it('carries on when a listener throws: the others are told and the restart completes', async () => {
    const r = rig();
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    try {
      const client = await started(r);
      const seen: string[] = [];
      client.onStateChanged(() => { throw new Error('window is gone'); });
      client.onStateChanged((state) => { seen.push(state.state); });
      client.onRestarted(() => { throw new Error('warmup failed to start'); });
      client.onRestarted(() => { seen.push('restarted'); });

      r.current().die();
      const held = client.runQuery('SELECT 1');
      r.current().ready();

      expect(seen).toEqual(['restarting', 'running', 'restarted']);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('window is gone'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('warmup failed to start'));
      r.current().say({ kind: 'rows', id: 0, rows: [] });
      await expect(held).resolves.toEqual([]);
    } finally {
      error.mockRestore();
    }
  });

  it('stops telling a listener that unsubscribed', async () => {
    const r = rig();
    const client = await started(r);
    const seen: string[] = [];
    const offState = client.onStateChanged(() => { seen.push('state'); });
    const offRestart = client.onRestarted(() => { seen.push('restarted'); });
    offState();
    offRestart();

    r.current().die();
    r.current().ready();
    expect(seen).toEqual([]);
  });

  it('treats an exit with code 0 as unexpected too: nothing asked the process to end', async () => {
    const r = rig();
    const client = await started(r);
    const query = client.runQuery('SELECT 1');

    r.current().die({ code: 0 });

    await expect(query).rejects.toThrow(/stopped unexpectedly/);
    expect(r.spawned).toHaveLength(2);
  });

  it('ignores what a dead process still says, and a second report of its exit', async () => {
    const r = rig();
    const client = await started(r);
    const dead = r.current();
    dead.die();
    const held = client.runQuery('SELECT 2');

    dead.say({ kind: 'ready' });
    dead.say({ kind: 'rows', id: 0, rows: [{ from: 'the dead' }] });
    dead.die();
    expect(await isSettled(held)).toBe(false);
    expect(r.spawned).toHaveLength(2);
    expect(r.current().posted).toEqual([]);

    r.current().ready();
    r.current().say({ kind: 'rows', id: 0, rows: [{ from: 'the living' }] });
    await expect(held).resolves.toEqual([{ from: 'the living' }]);
  });

  it('lets a view cancel the queries held for the restart, but not a held build', async () => {
    const r = rig();
    const client = await started(r);
    r.current().die();
    const query = client.runQuery('SELECT 1');
    const build = client.runBuildQuery('COPY x TO y');

    client.cancelPendingQueries();

    expect(await rejection(query)).toBe(QUERY_CANCELLED_MESSAGE);
    expect(await isSettled(build)).toBe(false);
    // Nothing to tell a process that has run nothing yet.
    r.current().ready();
    expect(r.current().posted).toEqual([{ kind: 'query', id: 1, sql: 'COPY x TO y', fresh: true }]);
  });

  it('cancels a held build too when asked to cancel everything', async () => {
    const r = rig();
    const client = await started(r);
    r.current().die();
    const query = client.runQuery('SELECT 1');
    const build = client.runBuildQuery('COPY x TO y');

    client.cancelAllQueries();

    expect(await rejection(query)).toBe(QUERY_CANCELLED_MESSAGE);
    expect(await rejection(build)).toBe(QUERY_CANCELLED_MESSAGE);
  });

  it('replaces a new process that dies before it is ready, keeping the held queries', async () => {
    const r = rig();
    const client = await started(r);
    r.current().die();
    const held = client.runQuery('SELECT 1');

    r.current().die({ code: 1 });
    expect(r.spawned).toHaveLength(3);
    expect(client.getState()).toEqual({ state: 'restarting' });

    r.current().ready();
    r.current().say({ kind: 'rows', id: 0, rows: [{ n: 1 }] });
    await expect(held).resolves.toEqual([{ n: 1 }]);
  });

  it('kills and replaces a new process that never says it is ready', async () => {
    vi.useFakeTimers();
    const r = rig();
    const client = await started(r);
    r.current().die();
    const stuck = r.current();

    const held = client.runQuery('SELECT 1');
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS);
    expect(stuck.kills).toBe(1);
    // Given up on there and then: a process stuck this badly may never
    // report its exit, and the queries held for it would wait for ever.
    expect(r.spawned).toHaveLength(3);
    // The exit it does report later is not a second death.
    stuck.die({ code: 0 });
    expect(r.spawned).toHaveLength(3);
    stuck.ready();
    expect(client.getState()).toEqual({ state: 'restarting' });

    // A process that got ready in time is left alone, and runs what was held.
    r.current().ready();
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS * 2);
    expect(r.current().kills).toBe(0);
    expect(client.getState().state).toBe('running');
    r.current().say({ kind: 'rows', id: 0, rows: [] });
    await expect(held).resolves.toEqual([]);
  });

  it('stops at the breaker when no replacement ever gets ready, though none reports its exit', async () => {
    vi.useFakeTimers();
    const r = rig();
    const client = await started(r);
    const held = (() => {
      r.current().die();
      return client.runQuery('SELECT 1');
    })();
    held.catch(() => undefined);

    // One death so far; two replacements that hang take it to three.
    await vi.advanceTimersByTimeAsync(START_TIMEOUT_MS * 2);

    expect(client.getState()).toMatchObject({ state: 'stopped', deaths: 3 });
    await expect(held).rejects.toThrow(/was not restarted/);
  });

  it('kills a new process that says it cannot start, and replaces it', async () => {
    const r = rig();
    await started(r);
    r.current().die();
    const failing = r.current();

    failing.say({ kind: 'error', id: -1, message: 'DuckDB worker init failed: out of memory' });
    expect(failing.kills).toBe(1);
    expect(r.spawned).toHaveLength(3);
    failing.die({ code: 0 });
    expect(r.spawned).toHaveLength(3);
  });
});

describe('the crash-loop breaker', () => {
  it('allows three deaths in ten minutes', () => {
    expect(MAX_DEATHS).toBe(3);
    expect(DEATH_WINDOW_MS).toBe(10 * 60_000);
  });

  it('stops restarting at the third death inside the window', async () => {
    const r = rig();
    const client = await started(r);

    r.current().die();
    r.current().ready();
    r.clock += 4 * 60_000;
    r.current().die();
    r.current().ready();
    expect(client.getState().state).toBe('running');

    r.clock += 5 * 60_000;
    const running = client.runQuery('SELECT 1');
    r.current().die();

    expect(client.getState()).toEqual({ state: 'stopped', deaths: 3, windowMinutes: 10 });
    expect(r.states.at(-1)).toEqual({ state: 'stopped', deaths: 3, windowMinutes: 10 });
    // No fourth process.
    expect(r.spawned).toHaveLength(3);
    // The query it took down is not told to run again: nothing would run it.
    await expect(running).rejects.toThrow(/was not restarted/);
  });

  it('fails every query at once while stopped, saying how to start again', async () => {
    const r = rig();
    const client = await started(r);
    for (let death = 1; death < MAX_DEATHS; death += 1) {
      r.current().die();
      r.current().ready();
    }
    r.current().die();

    const message = 'The query engine stopped 3 times in 10 minutes and was not restarted. Restart it from the notice at the top of the window.';
    expect(await rejection(client.runQuery('SELECT 1'))).toBe(message);
    expect(await rejection(client.runPreparedQuery('SELECT $1', [1]))).toBe(message);
    expect(await rejection(client.runBuildQuery('COPY x TO y'))).toBe(message);
    // Nothing to cancel or configure: neither reaches for a process.
    client.cancelPendingQueries();
    client.cancelAllQueries();
    client.configure({ threads: 2 });
    expect(r.spawned).toHaveLength(3);
  });

  it('fails the queries held for a restart that the breaker called off', async () => {
    const r = rig();
    const client = await started(r);
    r.current().die();
    r.current().die();
    const held = client.runQuery('SELECT 1');

    r.current().die();

    await expect(held).rejects.toThrow(/was not restarted/);
  });

  it('keeps restarting when the deaths are further apart than the window', async () => {
    const r = rig();
    const client = await started(r);

    for (let death = 0; death < 6; death += 1) {
      r.current().die();
      r.current().ready();
      // Two deaths per window, never three.
      r.clock += DEATH_WINDOW_MS / 2;
    }

    expect(client.getState().state).toBe('running');
    expect(r.spawned).toHaveLength(7);
  });

  it('counts a process that could not be started as a death', async () => {
    const r = rig();
    let failing = false;
    const client = await (async () => {
      const creating = createSupervisedDuckDBClient({
        spawn: (settings) => {
          if (failing) throw new Error('spawn EAGAIN');
          return r.spawn(settings);
        },
        now: () => r.clock,
      });
      r.current().ready();
      return creating;
    })();

    failing = true;
    r.current().die();

    // The death, then a failed start for each restart it was owed.
    expect(client.getState()).toEqual({ state: 'stopped', deaths: 3, windowMinutes: 10 });
    expect(r.spawned).toHaveLength(1);
  });

  it('starts again when asked, with a clean count', async () => {
    const r = rig();
    const client = await started(r);
    const restarts: number[] = [];
    client.onRestarted(() => { restarts.push(r.spawned.length); });
    for (let death = 1; death < MAX_DEATHS; death += 1) {
      r.current().die();
      r.current().ready();
    }
    r.current().die();
    expect(client.getState().state).toBe('stopped');
    r.states.length = 0;

    const restarting = client.restart();
    expect(r.spawned).toHaveLength(4);
    expect(client.getState()).toEqual({ state: 'restarting' });
    const held = client.runQuery('SELECT 1');
    r.clock += 100;
    r.current().ready();
    await restarting;

    expect(r.states).toEqual([{ state: 'restarting' }, { state: 'running', restartedAt: r.clock }]);
    expect(restarts).toEqual([2, 3, 4]);
    r.current().say({ kind: 'rows', id: 0, rows: [{ n: 1 }] });
    await expect(held).resolves.toEqual([{ n: 1 }]);

    // The three deaths before the restart no longer count.
    r.current().die();
    expect(client.getState()).toEqual({ state: 'restarting' });
  });

  it('reports a manual restart that ends stopped again', async () => {
    const r = rig();
    const client = await started(r);
    for (let death = 1; death < MAX_DEATHS; death += 1) {
      r.current().die();
      r.current().ready();
    }
    r.current().die();

    const restarting = client.restart();
    for (let death = 0; death < MAX_DEATHS; death += 1) r.current().die({ code: 1 });

    await expect(restarting).rejects.toThrow(/was not restarted/);
    expect(client.getState().state).toBe('stopped');
  });

  it('leaves a running engine alone when asked to restart', async () => {
    const r = rig();
    const client = await started(r);

    await client.restart();

    expect(r.spawned).toHaveLength(1);
    expect(r.current().kills).toBe(0);
    expect(r.states).toEqual([]);
  });
});

describe('shutting down', () => {
  it('kills the process, fails what was pending and starts nothing', async () => {
    const r = rig();
    const client = await started(r);
    const query = client.runQuery('SELECT 1');

    const terminating = client.terminate();
    expect(r.current().kills).toBe(1);
    expect(await rejection(query)).toBe('The query engine was shut down.');
    // Resolves once the process is gone.
    expect(await isSettled(terminating)).toBe(false);
    r.current().die({ code: 0 });
    await terminating;

    expect(r.spawned).toHaveLength(1);
    expect(await rejection(client.runQuery('SELECT 2'))).toBe('The query engine was shut down.');
    // A second call has nothing left to wait for.
    await client.terminate();
    expect(r.current().kills).toBe(1);
  });

  it('stops waiting for a process that does not report its exit', async () => {
    vi.useFakeTimers();
    const r = rig();
    const client = await started(r);

    const terminating = client.terminate();
    await vi.advanceTimersByTimeAsync(TERMINATE_TIMEOUT_MS);

    await terminating;
    expect(r.current().kills).toBe(1);
  });

  it('shuts down while a replacement is starting, failing the queries held for it', async () => {
    const r = rig();
    const client = await started(r);
    r.current().die();
    const held = client.runQuery('SELECT 1');

    const terminating = client.terminate();
    expect(r.current().kills).toBe(1);
    r.current().die({ code: 0 });
    await terminating;

    expect(await rejection(held)).toBe('The query engine was shut down.');
    expect(r.spawned).toHaveLength(2);
  });

  it('shuts down a stopped engine without a process to wait for', async () => {
    const r = rig();
    const client = await started(r);
    for (let death = 1; death < MAX_DEATHS; death += 1) {
      r.current().die();
      r.current().ready();
    }
    r.current().die();

    await client.terminate();

    await expect(client.restart()).rejects.toThrow('The query engine was shut down.');
    expect(r.spawned).toHaveLength(3);
  });
});

describe('the DuckDB process environment', () => {
  it('carries the host environment and the settings', () => {
    const env = duckdbProcessEnv({ PATH: '/usr/bin', COSTGOBLIN_DATA_DIR: '/ws/data', UNSET: undefined }, { tempDir: "/ws/tmp/it's here", memoryGB: 2, threads: 4 });

    expect(env).toMatchObject({ PATH: '/usr/bin', COSTGOBLIN_DATA_DIR: '/ws/data' });
    expect(JSON.parse(env[DUCKDB_SETTINGS_ENV] ?? '')).toEqual({ tempDir: "/ws/tmp/it's here", memoryGB: 2, threads: 4 });
    // Only strings: an unset variable is left out, not passed as "undefined".
    expect('UNSET' in env).toBe(false);
    expect(Object.values(env).every(value => typeof value === 'string')).toBe(true);
  });

  it('gives the process the thread pool the main process sized for itself', () => {
    // What main's startup put in its own environment travels to the child.
    expect(duckdbProcessEnv({ UV_THREADPOOL_SIZE: '28' }, {})['UV_THREADPOOL_SIZE']).toBe('28');
  });

  it('sizes the pool itself for a host that did not: a query holds a thread, and the default is four', () => {
    expect(duckdbProcessEnv({}, {})['UV_THREADPOOL_SIZE']).toBe(String(uvThreadpoolSize()));
    expect(uvThreadpoolSize()).toBeGreaterThan(4);
  });
});
