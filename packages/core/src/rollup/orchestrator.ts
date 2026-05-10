import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { parseEtagsJson, listLocalMonths } from '../sync/sync-utils.js';
import { buildOnePeriod, hashRawEtags } from './build-rollup.js';
import { freshPeriods, loadRollupManifest, removeRollupEntry, type RollupManifest } from './manifest.js';
import type { RollupSchema } from './schema.js';

/** Read sync-etags.json for the daily tier and return per-period file→hash maps. */
async function loadDailyEtags(dataDir: string): Promise<Record<string, Record<string, string>>> {
  try {
    const raw = await readFile(join(dataDir, 'sync-etags.json'), 'utf-8');
    return parseEtagsJson(raw);
  } catch {
    return {};
  }
}

/** Per-period rawHash for every daily period that has parquet on disk. */
async function computeRawHashes(dataDir: string): Promise<Map<string, string>> {
  const etags = await loadDailyEtags(dataDir);
  const localMonths = await listLocalMonths(dataDir, 'daily');
  const result = new Map<string, string>();
  for (const period of localMonths) {
    const periodEtags = etags[period] ?? {};
    result.set(period, hashRawEtags(periodEtags));
  }
  return result;
}

export interface RollupAvailability {
  readonly schema: RollupSchema;
  readonly fresh: ReadonlySet<string>;
  /** All periods that have raw parquet on disk — useful for diagnostics. */
  readonly knownPeriods: readonly string[];
}

export async function computeRollupAvailability(
  dataDir: string,
  schema: RollupSchema,
): Promise<RollupAvailability> {
  const manifest = await loadRollupManifest(dataDir);
  const rawHashes = await computeRawHashes(dataDir);
  const fresh = freshPeriods(manifest, schema.hash, rawHashes);
  return { schema, fresh, knownPeriods: [...rawHashes.keys()].sort((a, b) => a.localeCompare(b)) };
}

export interface BuildPendingOptions {
  readonly dataDir: string;
  readonly schema: RollupSchema;
  readonly availableColumns: ReadonlySet<string> | undefined;
  readonly runQuery: (sql: string) => Promise<readonly unknown[]>;
  /** Limit the build to these periods. When undefined, builds every stale or
   *  missing period. Pass the periods that just got synced for the post-sync
   *  hook so we don't accidentally rebuild old months that haven't changed. */
  readonly periods?: readonly string[] | undefined;
}

/**
 * Build any rollup that's missing or stale relative to the supplied schema.
 * Returns the list of periods that were (re)built. Periods that are already
 * fresh are skipped. Failures are logged but don't abort the loop — one bad
 * month shouldn't stop the rest from building.
 */
export async function buildPendingRollups(opts: BuildPendingOptions): Promise<readonly string[]> {
  const { dataDir, schema, availableColumns, runQuery, periods } = opts;

  const manifest = await loadRollupManifest(dataDir);
  const rawHashes = await computeRawHashes(dataDir);
  const fresh = freshPeriods(manifest, schema.hash, rawHashes);

  const candidates = periods === undefined
    ? [...rawHashes.keys()]
    : periods.filter(p => rawHashes.has(p));

  const built: string[] = [];
  for (const period of candidates) {
    if (fresh.has(period)) continue;
    const rawHash = rawHashes.get(period);
    if (rawHash === undefined) continue;
    try {
      await buildOnePeriod({ dataDir, period, schema, rawHash, availableColumns, runQuery });
      built.push(period);
    } catch (err: unknown) {
      logger.warn('rollup-build-failed', { period, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return built;
}

/**
 * Drop all rollup manifest entries whose schema hash doesn't match the supplied
 * one. Used when the dimensions config changes — the on-disk parquet files
 * become unreadable under the new schema and must be regenerated.
 *
 * Doesn't delete the parquet files themselves; the next buildPendingRollups
 * will overwrite them when it rebuilds. Leaving stale files on disk is harmless
 * (nothing reads them once the manifest entry is gone).
 */
export async function dropStaleManifestEntries(
  dataDir: string,
  schema: RollupSchema,
): Promise<readonly string[]> {
  const manifest = await loadRollupManifest(dataDir);
  const stale = staleEntries(manifest, schema);
  for (const period of stale) {
    await removeRollupEntry(dataDir, period);
  }
  return stale;
}

function staleEntries(manifest: RollupManifest, schema: RollupSchema): readonly string[] {
  const out: string[] = [];
  for (const [period, entry] of Object.entries(manifest.entries)) {
    if (entry.schemaHash !== schema.hash) out.push(period);
  }
  return out;
}
