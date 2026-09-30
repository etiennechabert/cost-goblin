import { sqlEscapeString } from './sql-escape.js';

/**
 * A sandboxed, locked DuckDB instance — the load-bearing control for queries
 * whose SQL comes from outside the app (the MCP `run_sql` / `explore_data`
 * tools). The shared app instance deliberately stays unrestricted: dashboards
 * and rollups read Parquet through it, and `enable_external_access` is
 * instance-global, so this sandbox is applied to a *dedicated* instance only.
 *
 * Pure and browser-safe (no node imports): the DuckDB worker bundle imports it
 * from `@costgoblin/core/browser`.
 */

/** Options for {@link buildDuckDbSandboxStatements}. Every path must be absolute
 *  and should already be canonical (realpath'd) — DuckDB canonicalises the file
 *  it is asked to open before matching, so a symlinked allow-list entry would
 *  never match. */
export interface DuckDbSandboxOptions {
  /** Directories the instance may read and write (recursively). Must be non-empty. */
  readonly allowedDirectories: readonly string[];
  /** Individual files the instance may read, outside the allowed directories. */
  readonly allowedPaths: readonly string[];
  /** Spill directory for out-of-core operators. */
  readonly tempDirectory: string;
  /** Cap on what the spill directory may hold. DuckDB's default is 90% of the
   *  free disk, and the lock below would make it uncorrectable, so one query
   *  could otherwise fill the user's disk. */
  readonly maxTempDirectorySizeGB: number;
  readonly memoryLimitGB: number;
  readonly threads: number;
}

/** POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) or UNC (`\\server\share`). */
function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

function assertAbsolutePath(p: string, name: string): void {
  if (p.length === 0 || p.includes('\u0000') || !isAbsolutePath(p)) {
    throw new Error(`DuckDB sandbox: ${name} must be an absolute path, got ${JSON.stringify(p)}`);
  }
}

function assertPositiveInteger(n: number, name: string): void {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`DuckDB sandbox: ${name} must be a positive integer, got ${String(n)}`);
  }
}

function sqlStringList(values: readonly string[]): string {
  return `[${values.map(v => `'${sqlEscapeString(v)}'`).join(', ')}]`;
}

/**
 * The ordered SET statements that sandbox and lock a fresh DuckDB instance.
 * Run them in order, on one connection, before the instance serves any query:
 *
 * 1. resource limits (memory, threads, spill dir and its size cap) — they cannot
 *    change after the lock;
 * 2. `allowed_directories`, then 3. `allowed_paths` — the only file-system grants;
 * 4. `enable_external_access = false` — every other file / URL is refused;
 * 5. extension auto-install / auto-load off — no extension load from disk;
 * 6. `lock_configuration = true` — every later SET (including one smuggled into
 *    a query) fails, and new connections inherit the sandbox.
 *
 * Throws on a relative/empty path, an empty directory allow-list, or a
 * non-positive-integer memory/thread count or spill cap.
 */
export function buildDuckDbSandboxStatements(opts: DuckDbSandboxOptions): readonly string[] {
  if (opts.allowedDirectories.length === 0) {
    throw new Error('DuckDB sandbox: allowedDirectories must not be empty');
  }
  for (const d of opts.allowedDirectories) assertAbsolutePath(d, 'allowedDirectories entry');
  for (const p of opts.allowedPaths) assertAbsolutePath(p, 'allowedPaths entry');
  assertAbsolutePath(opts.tempDirectory, 'tempDirectory');
  assertPositiveInteger(opts.memoryLimitGB, 'memoryLimitGB');
  assertPositiveInteger(opts.threads, 'threads');
  assertPositiveInteger(opts.maxTempDirectorySizeGB, 'maxTempDirectorySizeGB');

  return [
    `SET memory_limit = '${String(opts.memoryLimitGB)}GB'`,
    `SET threads = ${String(opts.threads)}`,
    `SET temp_directory = '${sqlEscapeString(opts.tempDirectory)}'`,
    `SET max_temp_directory_size = '${String(opts.maxTempDirectorySizeGB)}GB'`,
    `SET allowed_directories = ${sqlStringList(opts.allowedDirectories)}`,
    `SET allowed_paths = ${sqlStringList(opts.allowedPaths)}`,
    'SET enable_external_access = false',
    'SET autoinstall_known_extensions = false',
    'SET autoload_known_extensions = false',
    'SET lock_configuration = true',
  ];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/** Structural guard for sandbox options received across a trust boundary (the
 *  worker's `workerData`). Value checks are left to
 *  {@link buildDuckDbSandboxStatements}, which throws on bad values. */
export function isDuckDbSandboxOptions(value: unknown): value is DuckDbSandboxOptions {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return isStringArray(Reflect.get(value, 'allowedDirectories'))
    && isStringArray(Reflect.get(value, 'allowedPaths'))
    && typeof Reflect.get(value, 'tempDirectory') === 'string'
    && typeof Reflect.get(value, 'maxTempDirectorySizeGB') === 'number'
    && typeof Reflect.get(value, 'memoryLimitGB') === 'number'
    && typeof Reflect.get(value, 'threads') === 'number';
}
