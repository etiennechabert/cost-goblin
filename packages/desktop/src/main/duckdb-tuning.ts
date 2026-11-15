import { cpus, totalmem } from 'node:os';

/** DuckDB resource tuning — shared by the DuckDB bundle (to apply SET
 *  memory_limit / SET threads) and the main process (to compute the defaults
 *  shown in the UI and to resolve user overrides). Kept framework-free and
 *  side-effect-free so it bundles cleanly into the worker. */

/** Environment variable a process host sets on the DuckDB process it spawns:
 *  the settings to start with, as JSON (`{ tempDir?, memoryGB?, threads? }`).
 *  The bundle applies them before it reports ready (`duckdb-worker.ts`). */
export const DUCKDB_SETTINGS_ENV = 'COSTGOBLIN_DUCKDB_SETTINGS';

/** What a DuckDB instance is configured with: at spawn through
 *  {@link DUCKDB_SETTINGS_ENV}, later through a `configure` message. A
 *  setting left out keeps its computed default (or, for `tempDir`, DuckDB's). */
export interface DuckDBSettings {
  readonly tempDir?: string | undefined;
  readonly memoryGB?: number | undefined;
  readonly threads?: number | undefined;
}

export const MIN_MEMORY_GB = 1;
/** The most memory DuckDB may be told to use, whatever the machine has.
 *
 *  DuckDB runs in an Electron utility process (`duckdb-utility-process.ts`),
 *  and in every process Electron hosts `malloc` is Chromium's allocator, not
 *  the system's. That allocator serves the whole process from one 16 GiB
 *  reservation of address space, never returns what a size class has used to
 *  the others, and ends the process when the reservation runs out. A limit
 *  DuckDB cannot reach is therefore not a limit: it never spills to disk, it
 *  kills the process. The supervisor starts another, so the app stays up,
 *  but every query in flight fails and a rollup build starts over.
 *
 *  Measured on a 46 GB workspace (242M daily rows; macOS arm64, Electron 44),
 *  when DuckDB still ran inside the main process: with the limit at 12 GB or
 *  more, the rollup build at launch killed the app at about 9 GB resident, on
 *  every launch; at 10 GB and below it finished. A session then keeps using
 *  up the reservation as it runs queries of other shapes, so the ceiling sits
 *  well under the largest limit that survived a build. It costs the build
 *  nothing: the full 12-month rebuild took the same minute at 4, 6 and 10 GB.
 *  A process of its own did not move the wall: an allocation probe in a
 *  utility process died at about 12 GB, as it does in the main process.
 *
 *  The MCP instance (2 GB) and the GCP canonicalizer (2 GB) are worker
 *  threads of the main process and allocate from its reservation, not this
 *  one. Raise this only once DuckDB no longer allocates from Chromium's
 *  allocator. */
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
