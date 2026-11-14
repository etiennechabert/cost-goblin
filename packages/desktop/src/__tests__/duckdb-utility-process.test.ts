import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUERY_ENGINE_PROCESS_NAME, utilityProcessSpawner } from '../main/duckdb-utility-process.js';
import type { DuckDBProcessExit } from '../main/duckdb-supervisor.js';
import { DUCKDB_SETTINGS_ENV, computeUvThreadPoolSize } from '../main/duckdb-tuning.js';

/** How the app hosts the DuckDB bundle: an Electron utility process, here a
 *  stand-in for `utilityProcess.fork` that records how it was asked for and
 *  lets the test speak for the child. The real one runs in the e2e suites. */

interface FakeChild {
  readonly modulePath: string;
  readonly args: readonly string[];
  readonly options: unknown;
  readonly posted: unknown[];
  readonly stderr: { emit(event: string, ...args: unknown[]): boolean } | null;
  pid: number | undefined;
  kills: number;
  emit(event: string, ...args: unknown[]): boolean;
}

const electron = vi.hoisted(() => {
  const forked: FakeChild[] = [];
  return { forked, withStderr: true };
});

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  class Child extends EventEmitter {
    readonly posted: unknown[] = [];
    readonly stderr: InstanceType<typeof EventEmitter> | null = electron.withStderr ? new EventEmitter() : null;
    pid: number | undefined = 4242;
    kills = 0;
    constructor(readonly modulePath: string, readonly args: readonly string[], readonly options: unknown) {
      super();
    }
    postMessage(message: unknown): void { this.posted.push(message); }
    kill(): boolean {
      this.kills += 1;
      return true;
    }
  }
  return {
    utilityProcess: {
      fork(modulePath: string, args: readonly string[], options: unknown): Child {
        const child = new Child(modulePath, args, options);
        electron.forked.push(child);
        return child;
      },
    },
  };
});

function lastChild(): FakeChild {
  const child = electron.forked.at(-1);
  if (child === undefined) throw new Error('no utility process was forked');
  return child;
}

beforeEach(() => {
  electron.forked.length = 0;
  electron.withStderr = true;
});

describe('utilityProcessSpawner', () => {
  it('forks the bundle as a utility process under the engine\'s name, keeping its stderr', () => {
    const spawn = utilityProcessSpawner('/app/out/worker/duckdb-worker.cjs');
    expect(electron.forked).toHaveLength(0);

    const proc = spawn({});

    expect(lastChild()).toMatchObject({
      modulePath: '/app/out/worker/duckdb-worker.cjs',
      args: [],
      options: { serviceName: QUERY_ENGINE_PROCESS_NAME, stdio: ['ignore', 'inherit', 'pipe'] },
    });
    expect(proc.pid).toBe(4242);
    // A new process each time: the supervisor calls it again after a death.
    spawn({});
    expect(electron.forked).toHaveLength(2);
  });

  it('hands the process its settings in its environment, on top of the app\'s own', () => {
    vi.stubEnv('COSTGOBLIN_DATA_DIR', '/ws/data');
    try {
      utilityProcessSpawner('/w.cjs')({ tempDir: '/ws/tmp/it\'s here', memoryGB: 2, threads: 4 });

      const env: unknown = Reflect.get(Object(lastChild().options), 'env');
      expect(env).toMatchObject({ COSTGOBLIN_DATA_DIR: '/ws/data', PATH: process.env['PATH'] });
      const settings: unknown = JSON.parse(String(Reflect.get(Object(env), DUCKDB_SETTINGS_ENV)));
      expect(settings).toEqual({ tempDir: '/ws/tmp/it\'s here', memoryGB: 2, threads: 4 });
      // A thread pool sized for the queries the process runs.
      expect(env).toMatchObject({ UV_THREADPOOL_SIZE: String(computeUvThreadPoolSize()) });
      // Only strings: an unset variable is left out, not passed as "undefined".
      expect(Object.values(Object(env)).every(value => typeof value === 'string')).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('carries messages both ways', () => {
    const proc = utilityProcessSpawner('/w.cjs')({});
    const received: unknown[] = [];
    proc.onMessage((message) => { received.push(message); });

    proc.postMessage({ kind: 'query', id: 0, sql: 'SELECT 1' });
    lastChild().emit('message', { kind: 'rows', id: 0, rows: [{ n: 1n }] });

    expect(lastChild().posted).toEqual([{ kind: 'query', id: 0, sql: 'SELECT 1' }]);
    expect(received).toEqual([{ kind: 'rows', id: 0, rows: [{ n: 1n }] }]);
  });

  it('reports the exit code with the last of what the process wrote to stderr', () => {
    const forwarded = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const proc = utilityProcessSpawner('/w.cjs')({});
      const exits: DuckDBProcessExit[] = [];
      proc.onExit((exit) => { exits.push(exit); });

      lastChild().stderr?.emit('data', Buffer.from(`${'x'.repeat(5_000)}\n`));
      lastChild().stderr?.emit('data', 'libc++abi: terminating due to uncaught exception of type duckdb::OutOfMemoryException');
      lastChild().emit('exit', 6);

      expect(exits).toHaveLength(1);
      expect(exits[0]?.code).toBe(6);
      const tail = exits[0]?.stderrTail ?? '';
      // The end of the stream, where an abort says why; bounded, so a chatty
      // process cannot grow it.
      expect(tail).toHaveLength(2_000);
      expect(tail.endsWith('uncaught exception of type duckdb::OutOfMemoryException')).toBe(true);
      // Still shown where the app's own stderr goes.
      expect(forwarded).toHaveBeenCalledTimes(2);
    } finally {
      forwarded.mockRestore();
    }
  });

  it('reports an exit without stderr when the host gives it none', () => {
    electron.withStderr = false;
    const proc = utilityProcessSpawner('/w.cjs')({});
    const exits: DuckDBProcessExit[] = [];
    proc.onExit((exit) => { exits.push(exit); });

    lastChild().emit('exit', 9);

    expect(exits).toEqual([{ code: 9, stderrTail: '' }]);
  });

  it('kills the process when asked', () => {
    const proc = utilityProcessSpawner('/w.cjs')({});
    proc.kill();
    expect(lastChild().kills).toBe(1);
  });
});
