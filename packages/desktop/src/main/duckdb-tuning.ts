import { cpus, totalmem } from 'node:os';

/** DuckDB resource tuning — shared by the worker (to apply SET memory_limit /
 *  SET threads) and the main process (to compute the defaults shown in the UI
 *  and to resolve user overrides). Kept framework-free and side-effect-free so
 *  it bundles cleanly into the worker. */

export const MIN_MEMORY_GB = 1;
/** Ceiling so we never starve the OS + Electron (main/renderer/GPU/workers) +
 *  the user's other apps on very large machines. */
export const MAX_MEMORY_GB = 24;

export function totalMemoryGB(): number {
  return Math.max(1, Math.round(totalmem() / (1024 * 1024 * 1024)));
}

export function maxThreads(): number {
  return Math.max(1, cpus().length);
}

/** Default DuckDB memory_limit: ~half of physical RAM, clamped to
 *  [MIN_MEMORY_GB, MAX_MEMORY_GB]. The previous hard 4GB cap throttled large
 *  machines (a multi-GB in-memory cost_base plus concurrent aggregations spill
 *  to disk at 4GB); this scales with RAM while staying conservative. No-op on
 *  <=8GB laptops. */
export function computeDefaultMemoryGB(): number {
  const totalGB = totalmem() / (1024 * 1024 * 1024);
  return Math.round(Math.min(MAX_MEMORY_GB, Math.max(MIN_MEMORY_GB, totalGB * 0.5)));
}

/** Default DuckDB intra-query parallelism: all available logical cores (DuckDB's
 *  own default), surfaced explicitly so users can lower it to reduce contention. */
export function computeDefaultThreads(): number {
  return maxThreads();
}

function poolSizeOverride(): number | null {
  const raw = process.env['COSTGOBLIN_DUCKDB_POOL_SIZE'];
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 32) return n;
  }
  return null;
}

/** Cap on concurrent rollup partition builds (each on a fresh connection).
 *  min(max(4, cores), 16), overridable via COSTGOBLIN_DUCKDB_POOL_SIZE (1..32).
 *  NOTE: this no longer sizes the query connection pool — that is
 *  {@link computeQueryPoolSize}. Builds run on fresh connections, so their
 *  parallelism is independent of the (smaller) query gate. */
export function computeDefaultPoolSize(): number {
  return poolSizeOverride() ?? Math.min(Math.max(4, maxThreads()), 16);
}

/** Size of the worker's DuckDB connection pool = the cap on concurrent REGULAR
 *  (dashboard / Explorer) queries. Deliberately FAR below the core count:
 *  `SET threads` is instance-global, so N concurrent queries time-slice the SAME
 *  cores and a ~15 ms rollup query ends up queued behind multi-second raw scans
 *  (measured ~5 ms → ~550 ms under a burst of raw Table-widget scans). ~cores/4,
 *  clamped [2,4], gives each in-flight query a healthy thread share while a lone
 *  scan still gets all cores. Rollup builds use fresh connections capped by
 *  {@link computeDefaultPoolSize}, so this never throttles them. Override with
 *  COSTGOBLIN_DUCKDB_POOL_SIZE. */
export function computeQueryPoolSize(): number {
  return poolSizeOverride() ?? Math.max(2, Math.min(4, Math.ceil(maxThreads() / 4)));
}

/** Clamp a user-supplied memory override to a safe range. */
export function clampMemoryGB(gb: number): number {
  const ceiling = Math.max(MIN_MEMORY_GB, Math.min(MAX_MEMORY_GB, totalMemoryGB()));
  return Math.min(ceiling, Math.max(MIN_MEMORY_GB, Math.round(gb)));
}

/** Clamp a user-supplied thread override to [1, logical cores]. */
export function clampThreads(n: number): number {
  return Math.min(maxThreads(), Math.max(1, Math.round(n)));
}

/** Resolve the effective values to apply: a clamped override, or the computed
 *  default when the override is null/undefined ("auto"). */
export function resolveMemoryGB(override: number | null | undefined): number {
  return override === null || override === undefined ? computeDefaultMemoryGB() : clampMemoryGB(override);
}

export function resolveThreads(override: number | null | undefined): number {
  return override === null || override === undefined ? computeDefaultThreads() : clampThreads(override);
}
