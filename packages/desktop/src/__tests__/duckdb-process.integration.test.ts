import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_DEATHS, createSupervisedDuckDBClient } from '../main/duckdb-supervisor.js';
import type { DuckDBProcess, SupervisedDuckDBClient } from '../main/duckdb-supervisor.js';
import { forkDuckDBProcess } from './helpers/forked-duckdb-process.js';

/** The supervisor over REAL DuckDB processes: the built bundle, forked, and
 *  killed with SIGKILL the way the OS ends a process that ran out of memory.
 *  duckdb-supervisor.test.ts covers the supervisor's every branch against a
 *  stand-in; this shows the pieces hold together. */

const HERE = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(HERE, '..', '..', 'out', 'worker', 'duckdb-worker.cjs');

if (!existsSync(bundlePath)) {
  throw new Error(`Worker bundle not found at ${bundlePath}. Run "npm run build:worker" in packages/desktop first.`);
}

/** A cross join no machine finishes in the time a test takes to kill it. */
const ENDLESS_SQL = 'SELECT sum(a.range + b.range) AS total FROM range(200000) a, range(200000) b';
const SETTINGS_SQL = "SELECT current_setting('threads')::INTEGER AS threads, current_setting('memory_limit') AS memory, current_setting('temp_directory') AS temp";

describe('the DuckDB process, supervised', () => {
  let client: SupervisedDuckDBClient;
  let processes: DuckDBProcess[];
  let tempDir: string;

  function currentPid(): number {
    const pid = processes.at(-1)?.pid;
    if (pid === undefined) throw new Error('no DuckDB process is running');
    return pid;
  }

  /** Resolves once the engine is running again after a death. */
  function restarted(): Promise<void> {
    return new Promise<void>((resolve) => {
      const off = client.onRestarted(() => {
        off();
        resolve();
      });
    });
  }

  /** Start `sql` and resolve once DuckDB is running it. */
  function running(run: (onStarted: () => void) => Promise<unknown>): { started: Promise<void>; result: Promise<unknown> } {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    return { started, result: run(markStarted) };
  }

  beforeEach(async () => {
    // Four pooled connections whatever the machine has: the pool test below
    // needs to know how many queries fill it.
    vi.stubEnv('COSTGOBLIN_DUCKDB_POOL_SIZE', '4');
    processes = [];
    tempDir = await realpath(await mkdtemp(join(tmpdir(), 'cg-duckdb-process-')));
    client = await createSupervisedDuckDBClient({
      spawn: (settings) => {
        const proc = forkDuckDBProcess(bundlePath, settings);
        processes.push(proc);
        return proc;
      },
      // Two threads: the endless queries below should not take every core
      // from the suites running beside this one.
      settings: { tempDir, memoryGB: 1, threads: 2 },
    });
  });

  afterEach(async () => {
    await client.terminate();
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('runs queries in a process that is not this one', async () => {
    expect(await client.runQuery('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
    expect(await client.runPreparedQuery('SELECT $1::INTEGER + 1 AS next', [41])).toEqual([{ next: 42 }]);
    expect(await client.runBuildQuery("SELECT 'built' AS state")).toEqual([{ state: 'built' }]);
    // Values the structured clone must carry as they are.
    expect(await client.runQuery('SELECT 9007199254740993::BIGINT AS big')).toEqual([{ big: 9007199254740993n }]);
    expect(currentPid()).not.toBe(process.pid);
  });

  it('runs a rollup build while every pooled connection is busy', async () => {
    // Each running query holds a thread of the process's libuv pool until it
    // ends. With the default pool of four, four queries leave no thread for a
    // fifth: the build would wait for one of them, and so would every file
    // read in that process.
    const busy = Array.from({ length: 4 }, () => running(onStarted => client.runQuery(ENDLESS_SQL, onStarted)));
    for (const query of busy) query.result.catch(() => undefined);
    await Promise.all(busy.map(query => query.started));

    expect(await client.runBuildQuery("SELECT 'built' AS state")).toEqual([{ state: 'built' }]);
  }, 15_000);

  it('starts with the settings it was given, applied before its first query', async () => {
    // The very first query: nothing was sent to the process before it.
    expect(await client.runQuery(SETTINGS_SQL)).toEqual([expect.objectContaining({ threads: 2, temp: tempDir })]);
  });

  it('starts the next process with a setting changed while the first one ran', async () => {
    client.configure({ threads: 3 });
    await vi.waitFor(async () => {
      expect(await client.runQuery(SETTINGS_SQL)).toEqual([expect.objectContaining({ threads: 3 })]);
    });
    const back = restarted();

    process.kill(currentPid(), 'SIGKILL');
    await back;

    expect(await client.runQuery(SETTINGS_SQL)).toEqual([expect.objectContaining({ threads: 3, temp: tempDir })]);
  }, 30_000);

  it('survives the process being killed in the middle of a query', async () => {
    const [before] = await client.runQuery(SETTINGS_SQL);
    const firstPid = currentPid();
    const slow = running(onStarted => client.runQuery(ENDLESS_SQL, onStarted));
    await slow.started;

    process.kill(firstPid, 'SIGKILL');

    // The query the process was running fails, and says what happened.
    await expect(slow.result).rejects.toThrow('The query engine stopped unexpectedly and is restarting. Run the query again.');
    // The next one succeeds: it waits for the new process, then runs on it.
    expect(await client.runQuery('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
    expect(processes).toHaveLength(2);
    expect(currentPid()).not.toBe(firstPid);
    expect(client.getState()).toMatchObject({ state: 'running' });
    // Configured as the dead one was: its memory limit, threads and spill directory.
    expect(before).toMatchObject({ threads: 2, temp: tempDir });
    expect(await client.runQuery(SETTINGS_SQL)).toEqual([before]);
  }, 30_000);

  it('fails a rollup build the process was running, and builds on the next one', async () => {
    const build = running(onStarted => client.runBuildQuery(ENDLESS_SQL, onStarted));
    await build.started;

    process.kill(currentPid(), 'SIGKILL');

    await expect(build.result).rejects.toThrow(/stopped unexpectedly/);
    expect(await client.runBuildQuery("SELECT 'rebuilt' AS state")).toEqual([{ state: 'rebuilt' }]);
  }, 30_000);

  it('comes back from a kill while nothing was running', async () => {
    await client.runQuery('SELECT 1');
    const back = restarted();

    process.kill(currentPid(), 'SIGKILL');
    await back;

    expect(await client.runQuery('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
  }, 30_000);

  it('stops restarting after the third kill, and starts again when asked', async () => {
    for (let death = 1; death < MAX_DEATHS; death += 1) {
      const back = restarted();
      process.kill(currentPid(), 'SIGKILL');
      await back;
    }
    const stopped = new Promise<void>((resolve) => {
      client.onStateChanged((state) => { if (state.state === 'stopped') resolve(); });
    });
    process.kill(currentPid(), 'SIGKILL');
    await stopped;

    expect(processes).toHaveLength(MAX_DEATHS);
    await expect(client.runQuery('SELECT 1')).rejects.toThrow(/stopped 3 times in 10 minutes and was not restarted/);

    await client.restart();
    expect(await client.runQuery('SELECT 42 AS answer')).toEqual([{ answer: 42 }]);
    expect(processes).toHaveLength(MAX_DEATHS + 1);
  }, 30_000);
});
