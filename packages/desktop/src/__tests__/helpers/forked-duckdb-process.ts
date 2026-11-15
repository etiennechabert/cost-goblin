import { fork } from 'node:child_process';
import { duckdbProcessEnv } from '../../main/duckdb-supervisor.js';
import type { DuckDBProcess, DuckDBProcessExit, DuckDBSettings } from '../../main/duckdb-supervisor.js';

/**
 * The built DuckDB bundle in a child process of the test runner, behind the
 * interface the supervisor drives.
 *
 * The app runs the bundle in an Electron utility process, which only exists
 * inside Electron (the e2e suites cover it). Forked from Node, the same
 * bundle gives a node-project test a real DuckDB in a real separate process:
 * one it can kill with a signal while a query runs.
 */
export function forkDuckDBProcess(bundlePath: string, settings: DuckDBSettings): DuckDBProcess {
  const child = fork(bundlePath, [], {
    // The environment the app's own host gives it.
    env: duckdbProcessEnv(process.env, settings),
    // Structured clone, as a utility process's channel does: rows carry
    // BigInt and typed arrays, which JSON cannot.
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
  });
  let stderrTail = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  return {
    get pid(): number | undefined { return child.pid; },
    postMessage(message: unknown): void {
      if (typeof message !== 'object' || message === null) throw new Error('only objects are posted to the DuckDB process');
      // The callback takes a send that failed because the child just died;
      // its exit is what the supervisor acts on.
      child.send(message, () => undefined);
    },
    onMessage(listener: (message: unknown) => void): void {
      child.on('message', listener);
    },
    onExit(listener: (exit: DuckDBProcessExit) => void): void {
      child.once('exit', (code) => { listener({ code, stderrTail }); });
    },
    kill(): void {
      child.kill('SIGKILL');
    },
  };
}
