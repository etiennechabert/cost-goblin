import { computeQueryPoolSize, maxRollupConcurrency } from './duckdb-tuning.js';

/** Threads kept free for everything that is not a DuckDB call: the main
 *  process's own file reads, DNS lookups, hashing and compression. */
const IO_HEADROOM = 8;

/** How many libuv threads the process needs so that DuckDB cannot hold them
 *  all.
 *
 *  Every DuckDB call in flight occupies one thread of libuv's pool until it
 *  returns, and that pool is one per process, shared by the worker threads
 *  and by every async file, DNS, crypto and zlib call of the main process.
 *  libuv's default is 4. The app allows more DuckDB calls than that at once:
 *  the shared instance's pooled queries and its rollup builds, plus the MCP
 *  server's sandboxed instance. With 4 threads, the fifth call did not start
 *  until another returned, a cancel sent to it meanwhile was lost (DuckDB
 *  forgets an interrupt that arrives before the query has begun), and the
 *  main process's file reads waited behind multi-second queries.
 *
 *  A thread that waits for a query costs no CPU, so the size is simply the
 *  most calls there can be, plus the headroom.
 *
 *  The shared instance now runs in a process of its own, started with this
 *  same variable (`duckdbProcessEnv` in duckdb-supervisor.ts), so one size
 *  serves both: that process needs the shared instance's share, this one the
 *  sandboxed instance's and the headroom, and neither pays for the rest. */
export function uvThreadpoolSize(): number {
  const sharedInstance = computeQueryPoolSize() + maxRollupConcurrency();
  const sandboxedInstance = computeQueryPoolSize();
  return sharedInstance + sandboxedInstance + IO_HEADROOM;
}

/** Sizes libuv's thread pool, unless the environment already does. libuv
 *  reads UV_THREADPOOL_SIZE once, when the pool is first used: this has to run
 *  before anything in the process makes an async file, DNS, crypto or zlib
 *  call (see uv-threadpool-init.ts). */
export function ensureUvThreadpoolSize(env: NodeJS.ProcessEnv): void {
  const configured = env['UV_THREADPOOL_SIZE'];
  if (configured !== undefined && configured.trim().length > 0) return;
  env['UV_THREADPOOL_SIZE'] = String(uvThreadpoolSize());
}
