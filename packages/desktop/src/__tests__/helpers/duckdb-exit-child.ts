import { createDuckDBClient, drainDuckDBClientsSync } from '../../main/duckdb-client.js';

/**
 * Run by duckdb-drain.test.ts in a process of its own. It exits while DuckDB
 * queries are in flight, as the app does when it is quit during a rollup
 * build, which used to abort the process (`libc++abi: terminating due to
 * uncaught exception of type Napi::Error`). An abort can't be caught, so the
 * test reads this process's exit code and signal instead of dying with it.
 *
 * argv: <worker bundle path> <'running' | 'just-sent'>.
 */

// Minutes of work: still running whenever the exit lands.
const SLOW_QUERY = 'SELECT sum(a.range + b.range) AS total FROM range(300000) a, range(300000) b';

async function main(): Promise<void> {
  const [workerPath, mode] = process.argv.slice(2);
  if (workerPath === undefined || (mode !== 'running' && mode !== 'just-sent')) {
    throw new Error('usage: duckdb-exit-child <worker bundle> <running|just-sent>');
  }
  // What the main process registers (main.ts).
  process.on('exit', () => {
    drainDuckDBClientsSync();
  });
  const client = await createDuckDBClient(workerPath);

  const ignore = (): void => undefined;
  const started = Promise.all([
    new Promise<void>((resolve) => { client.runQuery(SLOW_QUERY, resolve).catch(ignore); }),
    new Promise<void>((resolve) => { client.runBuildQuery(SLOW_QUERY, resolve).catch(ignore); }),
    new Promise<void>((resolve) => { client.runPreparedQuery(SLOW_QUERY, [], resolve).catch(ignore); }),
  ]);
  // 'running': DuckDB is executing the queries. 'just-sent': the requests
  // have only been posted, so the exit races their start.
  if (mode === 'running') await started;

  process.exit(0);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
