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
