// ---------------------------------------------------------------------------
// Quit: the process exiting while worker threads still run DuckDB
// ---------------------------------------------------------------------------
// When the process exits it tears down every worker thread, whether or not a
// query is running. A DuckDB call still in flight in a torn-down thread aborts
// the whole process: its completion runs in an environment that can no longer
// take it, throws, and nothing catches the throw. So the exit handler drains
// every worker that hosts DuckDB first: the query worker (duckdb-client.ts)
// and the sync worker, whose GCP canonicalization runs its own instance
// (sync-client.ts). It can't wait for the workers' answers, because the event
// loop no longer turns at exit. What an exiting process can still do is read
// shared memory, so each worker counts the requests it has settled there.

/** One worker client's part in the drain at exit. */
export interface Drainable {
  /** Tells the worker to cancel everything. The client runs nothing afterwards. */
  beginDrain(): void;
  /** Blocks until the worker has settled every request posted to it, or
   *  `deadline` (epoch ms) passed. False when requests were still in flight. */
  waitSettledSync(deadline: number): boolean;
}

/** The clients whose worker thread is alive. A client adds itself when its
 *  worker is up and removes itself when the worker exits. */
export const liveDrainables = new Set<Drainable>();

/** The longest the exit waits for the work in flight to settle. It is all
 *  cancelled first and settles in milliseconds; this bounds the worst case,
 *  a query DuckDB is slow to interrupt. */
export const QUIT_DRAIN_MS = 3_000;

/** For the process's exit handler: cancels everything in every registered
 *  worker and blocks until it has all settled or `timeoutMs` passed. False
 *  when something was still in flight at the deadline. */
export function drainWorkersSync(timeoutMs: number = QUIT_DRAIN_MS): boolean {
  const deadline = Date.now() + timeoutMs;
  const clients = [...liveDrainables];
  for (const client of clients) client.beginDrain();
  let settled = true;
  for (const client of clients) settled = client.waitSettledSync(deadline) && settled;
  return settled;
}

/** Blocks on a worker's shared settled counter until it reaches `posted`, or
 *  `deadline` (epoch ms) passed. */
export function waitCounterSync(counter: Int32Array, posted: () => number, deadline: number, exited: () => boolean): boolean {
  for (;;) {
    if (exited()) return true;
    const seen = Atomics.load(counter, 0);
    if (seen >= posted()) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    Atomics.wait(counter, 0, seen, left);
  }
}
