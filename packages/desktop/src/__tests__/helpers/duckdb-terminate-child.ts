import { createDuckDBClient } from '../../main/duckdb-client.js';

/**
 * Run by duckdb-terminate.test.ts in a process of its own. It terminates a
 * DuckDB client while a query is in flight, which used to abort the process
 * hosting the worker thread (`libc++abi: terminating due to uncaught exception
 * of type Napi::Error`). An abort can't be caught, so the test reads this
 * process's exit code and signal instead of dying with it.
 *
 * argv: <worker bundle path> <'running' | 'just-sent'>. Prints one JSON line.
 */

// Tens of seconds of work: still running whenever the terminate lands.
const SLOW_QUERY = 'SELECT count(*) AS n FROM range(200000) a, range(200000) b';

function nextTick(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

async function main(): Promise<void> {
  const [workerPath, mode] = process.argv.slice(2);
  if (workerPath === undefined || (mode !== 'running' && mode !== 'just-sent')) {
    throw new Error('usage: duckdb-terminate-child <worker bundle> <running|just-sent>');
  }
  const client = await createDuckDBClient(workerPath);

  let outcome = 'pending';
  const started = new Promise<void>((resolve) => {
    client.runQuery(SLOW_QUERY, resolve).then(
      () => { outcome = 'rows'; },
      (err: unknown) => { outcome = err instanceof Error ? err.message : String(err); },
    );
  });
  // 'running': DuckDB is executing the query. 'just-sent': the request has
  // only been posted, so the terminate races the query's start.
  if (mode === 'running') await started;

  const begin = Date.now();
  await client.terminate();
  const terminateMs = Date.now() - begin;
  await nextTick();

  const afterTerminate = await client.runQuery('SELECT 1').then(
    () => 'rows',
    (err: unknown) => (err instanceof Error ? err.message : String(err)),
  );
  process.stdout.write(`${JSON.stringify({ outcome, afterTerminate, terminateMs })}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
