import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { isStringRecord } from '../utils/json.js';

export interface RollupEntry {
  readonly schemaHash: string;
  readonly builtAt: string;
  readonly rowCount: number;
  /** Hash of the raw parquet file etags for this period at build time.
   *  Used to detect "raw changed since last build" without having to re-run
   *  the rollup SQL — current month rebuilds every sync but closed months
   *  shouldn't waste work if the etags haven't moved. */
  readonly rawHash: string;
}

export interface RollupManifest {
  readonly version: 1;
  readonly entries: Readonly<Record<string, RollupEntry>>;
}

const MANIFEST_VERSION = 1 as const;

export function rollupDir(dataDir: string): string {
  return join(dataDir, 'aws', 'rollup');
}

export function rollupParquetPath(dataDir: string, period: string): string {
  return join(rollupDir(dataDir), `daily-${period}.parquet`);
}

function manifestPath(dataDir: string): string {
  return join(rollupDir(dataDir), 'manifest.json');
}

function emptyManifest(): RollupManifest {
  return { version: MANIFEST_VERSION, entries: {} };
}

function isRollupEntry(v: unknown): v is RollupEntry {
  if (!isStringRecord(v)) return false;
  return typeof v['schemaHash'] === 'string'
    && typeof v['builtAt'] === 'string'
    && typeof v['rowCount'] === 'number'
    && typeof v['rawHash'] === 'string';
}

export async function loadRollupManifest(dataDir: string): Promise<RollupManifest> {
  try {
    const raw = await readFile(manifestPath(dataDir), 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch {
      logger.warn('rollup manifest unparseable — treating as empty', { dataDir });
      return emptyManifest();
    }
    if (!isStringRecord(parsed)) return emptyManifest();
    const entriesRaw = parsed['entries'];
    if (!isStringRecord(entriesRaw)) return emptyManifest();
    const entries: Record<string, RollupEntry> = {};
    for (const [period, entry] of Object.entries(entriesRaw)) {
      if (!/^\d{4}-\d{2}$/.test(period)) continue;
      if (isRollupEntry(entry)) entries[period] = entry;
    }
    return { version: MANIFEST_VERSION, entries };
  } catch {
    return emptyManifest();
  }
}

export async function saveRollupManifest(dataDir: string, manifest: RollupManifest): Promise<void> {
  await mkdir(rollupDir(dataDir), { recursive: true });
  await writeFile(manifestPath(dataDir), JSON.stringify(manifest, null, 2));
}

export async function upsertRollupEntry(
  dataDir: string,
  period: string,
  entry: RollupEntry,
): Promise<void> {
  const current = await loadRollupManifest(dataDir);
  const next: RollupManifest = {
    version: MANIFEST_VERSION,
    entries: { ...current.entries, [period]: entry },
  };
  await saveRollupManifest(dataDir, next);
}

export async function removeRollupEntry(
  dataDir: string,
  period: string,
): Promise<void> {
  const current = await loadRollupManifest(dataDir);
  if (current.entries[period] === undefined) return;
  const nextEntries: Record<string, RollupEntry> = {};
  for (const [k, v] of Object.entries(current.entries)) {
    if (k !== period) nextEntries[k] = v;
  }
  await saveRollupManifest(dataDir, { version: MANIFEST_VERSION, entries: nextEntries });
}

/** Returns the periods whose rollup is fresh under the given schema hash AND
 *  whose stored rawHash matches the supplied one. Caller computes rawHash from
 *  the current sync-etags so we detect raw changes between rollup builds. */
export function freshPeriods(
  manifest: RollupManifest,
  schemaHash: string,
  rawHashesByPeriod: ReadonlyMap<string, string>,
): Set<string> {
  const fresh = new Set<string>();
  for (const [period, entry] of Object.entries(manifest.entries)) {
    if (entry.schemaHash !== schemaHash) continue;
    const expectedRawHash = rawHashesByPeriod.get(period);
    if (expectedRawHash === undefined) continue;
    if (entry.rawHash !== expectedRawHash) continue;
    fresh.add(period);
  }
  return fresh;
}
