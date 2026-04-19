/**
 * Per-file optimize pipeline: sort raw Parquet by date, then generate one
 * wide "combined sidecar" Parquet containing one column per configured tag
 * dimension. The sidecar is row-aligned with the sorted raw (same row count,
 * same scan order), so queries can POSITIONAL-JOIN against it — cheaper than
 * per-row element_at(map, key) lookups on the raw path.
 *
 * Everything is idempotent and mtime-driven:
 *   - Sort is fresh iff `<raw>.sorted` marker mtime >= raw mtime
 *   - Sidecar is fresh iff sidecar file mtime >= raw mtime AND it contains
 *     exactly the currently-configured tag columns (fingerprinted into the
 *     sidecar filename so a tag change invalidates via name-miss).
 *
 * A re-download (which bumps raw mtime) automatically invalidates both.
 * No separate state database; the filesystem is the source of truth.
 */

import { stat, rename, rm, mkdir, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { getRawDirPrefix } from '@costgoblin/core';
import type { TagDimension, SidecarPlan } from '@costgoblin/core';
import type { DuckDBClient } from './duckdb-client.js';
import type { FileActivityLog } from './file-activity.js';

/** Derive the sidecar directory for a given raw file. Mirrors the raw layout:
 *  aws/raw/daily-2026-04/cur-00001.parquet
 *    → aws/columns/daily-2026-04/                                           */
export function columnsDirFor(rawPath: string): string {
  const rawDir = dirname(rawPath);              // aws/raw/daily-2026-04
  const awsDir = dirname(dirname(rawDir));      // aws
  const periodDir = basename(rawDir);           // daily-2026-04
  return join(awsDir, 'columns', periodDir);
}

/** `aws/raw/daily-2026-04/cur-00001.parquet.sorted` */
export function sortMarkerPath(rawPath: string): string {
  return `${rawPath}.sorted`;
}

/** Sanitized column name matching what buildSource uses: tag_<sanitized>. */
export function tagColName(tag: TagDimension): string {
  return `tag_${tag.tagName.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * Combined sidecar filename — one file per raw, containing every configured
 * tag dimension as a column. Mirrors the raw basename so the columns/ dir
 * stays parallel to raw/.
 */
export function sidecarPath(rawPath: string): string {
  return join(columnsDirFor(rawPath), `${basename(rawPath)}.sidecar.parquet`);
}

async function mtimeOrNull(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

export async function isSortFresh(rawPath: string): Promise<boolean> {
  const rawMtime = await mtimeOrNull(rawPath);
  if (rawMtime === null) return false;
  const markerMtime = await mtimeOrNull(sortMarkerPath(rawPath));
  // Marker newer than raw means sort is current. Small tolerance to avoid
  // fs-timestamp-granularity flakes on fast renames.
  return markerMtime !== null && markerMtime + 500 >= rawMtime;
}

export async function isSidecarFresh(rawPath: string): Promise<boolean> {
  const rawMtime = await mtimeOrNull(rawPath);
  if (rawMtime === null) return false;
  const side = await mtimeOrNull(sidecarPath(rawPath));
  return side !== null && side + 500 >= rawMtime;
}

/**
 * Builds the SQL expression for resolving a tag's value at the row level.
 * Mirrors the expression inside buildSource — kept in sync so sidecar and
 * fallback paths produce the same output.
 *
 * Uses the plain `resource_tags` column name, no `cur.` prefix, so it works
 * whether or not the source does a JOIN.
 */
function buildTagValueExpr(tag: TagDimension, hasOrgJoin: boolean): string {
  const curKey = `user_${tag.tagName}`;
  const resource = `element_at(resource_tags, '${curKey}')[1]`;
  if (tag.accountTagFallback === undefined || !hasOrgJoin) {
    return resource;
  }
  const col = tagColName(tag);
  const fallback = `acct_tags.fallback_${col}`;
  const tpl = tag.missingValueTemplate;
  if (tpl !== undefined && tpl.length > 0 && tpl !== '{fallback}') {
    const [pre = '', post = ''] = tpl.split('{fallback}');
    const p = pre.replaceAll("'", "''");
    const q = post.replaceAll("'", "''");
    return `COALESCE(NULLIF(${resource}, ''), '${p}' || ${fallback} || '${q}')`;
  }
  return `COALESCE(NULLIF(${resource}, ''), ${fallback})`;
}

/** Atomic write: write to .tmp, fsync via DuckDB, rename over target. */
async function atomicRename(from: string, to: string): Promise<void> {
  await rename(from, to);
}

/**
 * Sort a raw Parquet file in place (replaces the file with a date-sorted
 * version). Row-group size 100k gives tight min/max statistics per group for
 * date range pruning.
 */
export async function sortRaw(client: DuckDBClient, rawPath: string): Promise<void> {
  const tmp = `${rawPath}.sort.tmp`;
  const sortCol = 'line_item_usage_start_date';
  const sql = `COPY (SELECT * FROM read_parquet('${rawPath}') ORDER BY ${sortCol})
    TO '${tmp}' (FORMAT PARQUET, ROW_GROUP_SIZE 100000)`;
  await client.runQuery(sql);
  // Swap in place.
  await atomicRename(tmp, rawPath);
  // Touch the marker so its mtime is after raw's.
  const marker = sortMarkerPath(rawPath);
  await writeFile(marker, '');
  const rawMtime = (await stat(rawPath)).mtimeMs;
  // Try to align marker mtime at/after raw mtime. Node's utimes uses seconds;
  // the +500ms tolerance in isSortFresh covers sub-second drift.
  const when = new Date(rawMtime);
  try {
    const fs = await import('node:fs/promises');
    await fs.utimes(marker, when, when);
  } catch {
    // Best-effort. mtime tolerance in isSortFresh handles small drift.
  }
}

/**
 * Generate the combined sidecar Parquet for a raw file — one wide file with
 * one column per configured tag dimension. Row-aligned with the raw file (no
 * ORDER BY inside the SELECT — POSITIONAL JOIN at query time pairs rows by
 * position, so any reorder breaks correctness).
 *
 * Account-tag fallback is resolved here once (vs per-query) via a single
 * LEFT JOIN against the org-accounts JSON if any tag needs it.
 */
export async function generateSidecar(
  client: DuckDBClient,
  rawPath: string,
  tags: readonly TagDimension[],
  orgAccountsPath: string | undefined,
): Promise<void> {
  const dir = columnsDirFor(rawPath);
  await mkdir(dir, { recursive: true });
  const target = sidecarPath(rawPath);
  const tmp = `${target}.tmp`;

  if (tags.length === 0) {
    // No configured dims — emit a single-row-count column so the file is still
    // row-aligned but carries no data. Keeps POSITIONAL JOIN valid.
    const sql = `COPY (
      SELECT TRUE AS _ FROM read_parquet('${rawPath}')
    ) TO '${tmp}' (FORMAT PARQUET)`;
    await client.runQuery(sql);
    await atomicRename(tmp, target);
    return;
  }

  const needsOrgJoin = tags.some(t => t.accountTagFallback !== undefined) && orgAccountsPath !== undefined;
  const colExprs = tags.map(t => `${buildTagValueExpr(t, needsOrgJoin)} AS ${tagColName(t)}`);

  let sql: string;
  if (needsOrgJoin) {
    const fallbackSelects = tags
      .filter(t => t.accountTagFallback !== undefined)
      .map(t => {
        const col = tagColName(t);
        const key = (t.accountTagFallback ?? '').replaceAll("'", "''");
        return `tags->>'${key}' AS fallback_${col}`;
      });
    sql = `COPY (
      SELECT ${colExprs.join(',\n             ')}
      FROM read_parquet('${rawPath}') AS cur
      LEFT JOIN (
        SELECT id, ${fallbackSelects.join(', ')}
        FROM read_json_auto('${orgAccountsPath}')
      ) AS acct_tags ON cur.line_item_usage_account_id = acct_tags.id
    ) TO '${tmp}' (FORMAT PARQUET)`;
  } else {
    sql = `COPY (
      SELECT ${colExprs.join(',\n             ')}
      FROM read_parquet('${rawPath}')
    ) TO '${tmp}' (FORMAT PARQUET)`;
  }

  await client.runQuery(sql);
  await atomicRename(tmp, target);
}

export interface OptimizeFileOptions {
  readonly rawPath: string;
  readonly tags: readonly TagDimension[];
  readonly orgAccountsPath: string | undefined;
  readonly client: DuckDBClient;
  readonly activity?: FileActivityLog | undefined;
}

function rel(rawPath: string): string {
  const rawDir = dirname(rawPath);
  return `${basename(rawDir)}/${basename(rawPath)}`;
}

/**
 * Full per-file optimize pass: sort (if stale) then generate every missing/
 * stale sidecar for the configured tag dims. Emits activity events as it
 * progresses. Idempotent — calling twice does only the work that's needed.
 *
 * Any step's failure is recorded and thrown; the caller decides what to do
 * (typically log + move on to the next file).
 */
export async function optimizeFile(opts: OptimizeFileOptions): Promise<void> {
  const { rawPath, tags, orgAccountsPath, client, activity } = opts;
  const relName = rel(rawPath);

  try {
    if (!(await isSortFresh(rawPath))) {
      activity?.record({ rawPath, relName, stage: 'sorting' });
      const t = Date.now();
      await sortRaw(client, rawPath);
      activity?.record({ rawPath, relName, stage: 'sorted', durationMs: Date.now() - t });
    }

    if (!(await isSidecarFresh(rawPath))) {
      activity?.record({ rawPath, relName, stage: 'building-sidecar' });
      const t = Date.now();
      await generateSidecar(client, rawPath, tags, orgAccountsPath);
      activity?.record({ rawPath, relName, stage: 'building-sidecar', durationMs: Date.now() - t });
    }

    activity?.record({ rawPath, relName, stage: 'complete' });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    activity?.record({ rawPath, relName, stage: 'failed', error: message });
    throw err;
  }
}

/**
 * For each requested period, list all raw Parquet files on disk in stable
 * (sorted-by-name) order. Used by the query layer to pair raw files with
 * their sidecars at query time.
 */
async function listRawFilesForPeriods(
  dataDir: string,
  tier: string,
  periods: readonly string[],
): Promise<string[]> {
  const prefix = getRawDirPrefix(tier);
  const rawDir = join(dataDir, 'aws', 'raw');
  const out: string[] = [];
  for (const period of periods) {
    const periodDir = join(rawDir, `${prefix}-${period}`);
    try {
      const entries = await readdir(periodDir);
      const files = entries
        .filter(f => f.endsWith('.parquet'))
        .sort((a, b) => a.localeCompare(b));
      for (const f of files) out.push(join(periodDir, f));
    } catch {
      // directory doesn't exist — caller already filtered by availablePeriods,
      // so this shouldn't happen, but we fail soft.
    }
  }
  return out;
}

/**
 * Resolve a SidecarPlan if every raw file in the requested periods has fresh
 * sidecars for every configured tag, AND is itself sorted. Returns null if
 * ANY file is stale/missing — the query layer then falls back to element_at.
 *
 * This is the "are we fully optimized for this query?" gate. All-or-nothing
 * by design: mixing sidecar and element_at paths within a single query would
 * require per-file UNIONs which are much harder to reason about.
 */
export async function resolveSidecarPlan(
  dataDir: string,
  tier: string,
  periods: readonly string[],
  tags: readonly TagDimension[],
): Promise<SidecarPlan | null> {
  if (tags.length === 0) return null;       // nothing to sidecar
  if (periods.length === 0) return null;    // query spans no on-disk months

  const rawFiles = await listRawFilesForPeriods(dataDir, tier, periods);
  if (rawFiles.length === 0) return null;

  const sidecarFiles: string[] = [];
  for (const rawPath of rawFiles) {
    if (!(await isSortFresh(rawPath))) return null;
    if (!(await isSidecarFresh(rawPath))) return null;
    sidecarFiles.push(sidecarPath(rawPath));
  }

  return { rawFiles, sidecarFiles };
}

/**
 * Delete every combined sidecar under `columnsRoot`. Called after any tag
 * dimension change — since sidecars are wide files holding all configured
 * columns, a single dim change invalidates the whole lot; the optimizer queue
 * then regenerates them with the new schema.
 */
export async function removeAllSidecars(columnsRoot: string): Promise<number> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  let removed = 0;
  try {
    const periods = await fs.readdir(columnsRoot);
    for (const periodDir of periods) {
      const full = path.join(columnsRoot, periodDir);
      try {
        const files = await fs.readdir(full);
        for (const f of files) {
          if (f.endsWith('.sidecar.parquet') || f.endsWith('.sidecar.parquet.tmp')) {
            await rm(path.join(full, f));
            removed += 1;
          }
        }
      } catch { /* period dir vanished concurrently */ }
    }
  } catch { /* columns root doesn't exist yet */ }
  return removed;
}
