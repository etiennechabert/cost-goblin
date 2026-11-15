import { cpus, totalmem } from 'node:os';

/** DuckDB resource tuning — shared by the worker (to apply SET memory_limit /
 *  SET threads) and the main process (to compute the defaults shown in the UI
 *  and to resolve user overrides). Kept framework-free and side-effect-free so
 *  it bundles cleanly into the worker. */

export const MIN_MEMORY_GB = 1;
/** The most memory DuckDB may be told to use, whatever the machine has.
 *
 *  DuckDB runs inside the app's main process, where `malloc` is Chromium's
 *  allocator, not the system's. That allocator serves the whole process from
 *  one 16 GiB reservation of address space, never returns what a size class
 *  has used to the others, and ends the process (the app, not the query) when
 *  the reservation runs out. A limit DuckDB cannot reach is therefore not a
 *  limit: it never spills to disk, it takes the app down.
 *
 *  Measured on a 46 GB workspace (242M daily rows; macOS arm64, Electron 44):
 *  with the limit at 12 GB or more, the rollup build at launch killed the app
 *  at about 9 GB resident, on every launch; at 10 GB and below it finished.
 *  A session then keeps using up the reservation as it runs queries of other
 *  shapes, so the ceiling sits well under the largest limit that survived a
 *  build. It costs the build nothing: the full 12-month rebuild took the same
 *  minute at 4, 6 and 10 GB.
 *
 *  The MCP instance (2 GB) and the GCP canonicalizer (2 GB) allocate from the
 *  same reservation. Raise this only with DuckDB in a process of its own. */
export const MAX_MEMORY_GB = 4;

export function totalMemoryGB(): number {
  return Math.max(1, Math.round(totalmem() / (1024 * 1024 * 1024)));
}

export function maxThreads(): number {
  return Math.max(1, cpus().length);
}

/** Default DuckDB memory_limit: half of physical RAM, clamped to
 *  [MIN_MEMORY_GB, MAX_MEMORY_GB]. Every machine with 8 GB or more gets the
 *  ceiling; past it DuckDB spills to the workspace's temp directory. */
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

/** Default number of monthly rollup partitions built in parallel. Deliberately
 *  low (2): each partition build is a heavy DuckDB scan, and running more than a
 *  couple at once starves the cores that keep dashboards/the UI responsive while
 *  a rebuild runs, for little wall-clock gain. Users can raise it in Performance
 *  settings up to {@link maxRollupConcurrency}. */
export const DEFAULT_ROLLUP_CONCURRENCY = 2;

/** Upper bound for the rollup-build-parallelism override: the build-pool cap.
 *  Building more partitions at once than there are fresh connections can't help. */
export function maxRollupConcurrency(): number {
  return computeDefaultPoolSize();
}

/** Clamp a user-supplied rollup-concurrency override to [1, maxRollupConcurrency]. */
export function clampRollupConcurrency(n: number): number {
  return Math.min(maxRollupConcurrency(), Math.max(1, Math.round(n)));
}

/** Resolve the effective rollup build parallelism: a clamped override, or the
 *  default ("auto") when null/undefined. The default itself is clamped to
 *  maxRollupConcurrency so that on a machine whose pool cap is below the default
 *  (e.g. COSTGOBLIN_DUCKDB_POOL_SIZE=1) "auto" never exceeds the real maximum. */
export function resolveRollupConcurrency(override: number | null | undefined): number {
  return clampRollupConcurrency(override ?? DEFAULT_ROLLUP_CONCURRENCY);
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
