import { utilityProcess } from 'electron';
import { logger } from '@costgoblin/core';
import type { DuckDBProcess, DuckDBProcessExit, DuckDBSettings, SpawnDuckDBProcess } from './duckdb-supervisor.js';
import { duckdbProcessEnv } from './duckdb-tuning.js';

/** The name the DuckDB process goes by in `app.getAppMetrics()` and in
 *  Electron's `child-process-gone` event. */
export const QUERY_ENGINE_PROCESS_NAME = 'CostGoblin query engine';

/** How much of the process's stderr is kept for the log line about its death. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * Hosts the DuckDB bundle in an Electron utility process: a child of the main
 * process that runs Node, with a structured-clone message channel like a
 * worker thread's. Chosen over a child process forked with
 * `ELECTRON_RUN_AS_NODE`: it runs in Electron's helper executable rather than
 * a second copy of the app's own, it does not depend on the `runAsNode` fuse
 * staying on, and its native crashes reach Crashpad like any other child's.
 * Both carry rows at the speed a worker thread does, and both allocate from
 * Chromium's allocator, so neither lifts the memory ceiling
 * (`MAX_MEMORY_GB`).
 *
 * `utilityProcess.fork` throws before the app is ready.
 */
export function utilityProcessSpawner(bundlePath: string): SpawnDuckDBProcess {
  return (settings: DuckDBSettings): DuckDBProcess => {
    const child = utilityProcess.fork(bundlePath, [], {
      serviceName: QUERY_ENGINE_PROCESS_NAME,
      // The settings the bundle starts with, and a thread pool sized for
      // the queries it runs (see computeUvThreadPoolSize).
      env: duckdbProcessEnv(process.env, settings),
      // stderr is piped to keep its end: that is where a native abort says
      // why ("terminating due to uncaught exception of type ...").
      stdio: ['ignore', 'inherit', 'pipe'],
    });
    // A fatal V8 error in the child. Its exit follows and is what the
    // supervisor acts on; without a listener, the 'error' event would throw
    // in this process, the one the child's failures must not reach.
    child.on('error', (type, location) => {
      logger.error('duckdb: the query engine process reported a fatal error', { type, location });
    });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
      process.stderr.write(chunk);
    });
    return {
      get pid(): number | undefined { return child.pid; },
      postMessage(message: unknown): void {
        child.postMessage(message);
      },
      onMessage(listener: (message: unknown) => void): void {
        child.on('message', listener);
      },
      onExit(listener: (exit: DuckDBProcessExit) => void): void {
        child.once('exit', (code) => { listener({ code, stderrTail }); });
      },
      kill(): void {
        child.kill();
      },
    };
  };
}
