import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { isStringRecord, isValidProviderName, logger } from '@costgoblin/core';

/** Sync sidecars that lived at the dataDir ROOT before #516 and move into
 *  `{providerName}/meta/`. Keep in lockstep with core's TIER_ETAG_FILES +
 *  sync-timestamps.json. */
const ROOT_SIDECAR_FILES: readonly string[] = [
  'sync-etags.json',
  'sync-etags-hourly.json',
  'sync-etags-cost-optimization.json',
  'sync-timestamps.json',
];

/** The first provider's name from costgoblin.yaml, read tolerantly and
 *  validated as a safe directory segment. Null when the config is missing,
 *  malformed, has no providers, or names something path-unsafe — in every
 *  such case the migration is skipped (the app surfaces the config problem
 *  through its normal load path). Accepts both the current flattened
 *  `credentialsProfile` shape and legacy `credentials.profile` configs —
 *  only `name` is read here. */
function readFirstProviderNameSync(configPath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch {
    return null;
  }
  if (!isStringRecord(parsed) || !Array.isArray(parsed['providers'])) return null;
  const first: unknown = parsed['providers'][0];
  if (!isStringRecord(first)) return null;
  const name = first['name'];
  if (typeof name !== 'string' || !isValidProviderName(name)) return null;
  return name;
}

/** One-shot migration of a pre-#516 data layout to the provider-keyed one:
 *
 *    {dataDir}/aws/{raw,rollup}        → {dataDir}/{firstProviderName}/{raw,rollup}
 *    {dataDir}/sync-etags*.json        → {dataDir}/{firstProviderName}/meta/
 *    {dataDir}/sync-timestamps.json    → {dataDir}/{firstProviderName}/meta/
 *
 *  Runs synchronously at boot, BEFORE the DuckDB and sync workers start, so
 *  no open file handles can break the renames (the same constraint that
 *  shaped #518's workspace migration). Every step is guarded and idempotent
 *  — renames are atomic, so a crash leaves either the old or the new layout,
 *  and re-running resumes cleanly. The rollup manifest stores no absolute
 *  paths, so it stays valid across the rename.
 *
 *  When a provider named `aws` is configured, the directory already matches
 *  the new layout and only the root sidecars move. When BOTH the legacy
 *  `aws/` dir and the provider dir exist, nothing is touched (ambiguous —
 *  never risk clobbering data) and a warning is logged. */
export function migrateProviderLayoutSync(dataDir: string, configPath: string): boolean {
  const name = readFirstProviderNameSync(configPath);
  if (name === null) return false;

  let migrated = false;
  const legacyRoot = join(dataDir, 'aws');
  const providerRoot = join(dataDir, name);

  if (name !== 'aws' && existsSync(legacyRoot)) {
    if (existsSync(providerRoot)) {
      logger.warn(
        `provider-layout migration: both ${legacyRoot} and ${providerRoot} exist — leaving the legacy dir untouched`,
      );
    } else {
      renameSync(legacyRoot, providerRoot);
      logger.info(`provider-layout migration: renamed data/aws → data/${name}`);
      migrated = true;
    }
  }

  const metaDir = join(providerRoot, 'meta');
  for (const file of ROOT_SIDECAR_FILES) {
    const src = join(dataDir, file);
    if (!existsSync(src)) continue;
    const dest = join(metaDir, file);
    if (existsSync(dest)) {
      // The meta copy is authoritative (written by post-#516 syncs); the root
      // file is a stale pre-migration cache — safe to drop, it only ever
      // triggers a redundant re-download if it was actually newer.
      rmSync(src, { force: true });
    } else {
      mkdirSync(metaDir, { recursive: true });
      renameSync(src, dest);
    }
    migrated = true;
  }

  return migrated;
}
