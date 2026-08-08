/** Detects and clears pre-FOCUS (AWS CUR 2.0) local data left behind by a
 *  v0.6.x install. v0.7.0's query layer reads FOCUS 1.2 columns that no CUR
 *  export has, so on upgrade every dashboard binder-errors and the still-
 *  configured CUR bucket syncs nothing — with no user-visible explanation. The
 *  boot path uses this to detect that case, and (on the user's confirm) wipe the
 *  old data and config so the app restarts into the setup wizard.
 *
 *  The DuckDB-touching part (reading a parquet's columns) is injected as a
 *  callback so the detection scan is unit-testable without a worker. */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** FOCUS sentinel columns present in every readable export and in no AWS CUR
 *  2.0 one. `buildSource` selects ChargePeriodStart/BilledCost directly, so a
 *  raw parquet missing either binder-errors every query. */
const FOCUS_SENTINEL_COLUMNS = ['ChargePeriodStart', 'BilledCost'] as const;

/** FOCUS-billing raw period-dir names: `{tier}-YYYY-MM` for the daily/hourly
 *  tiers only. The cost-optimization tier (`cost-opt-…`) is deliberately
 *  excluded — it carries Cost Optimization Hub recommendations, a different
 *  schema that has no FOCUS billing columns, so probing it for FOCUS sentinels
 *  would false-positive a valid cost-opt export as pre-FOCUS and offer to wipe. */
const RAW_PERIOD_DIR_RE = /^(?:daily|hourly)-\d{4}-(?:0[1-9]|1[0-2])$/;

/** True when a parquet's columns are a pre-FOCUS (CUR 2.0) shape the query
 *  layer cannot read — missing a FOCUS sentinel column. Pure, exported for
 *  tests. An empty column list is treated as NOT pre-FOCUS: describing nothing
 *  is a read failure, not evidence of CUR data, and must never trigger a wipe. */
export function isPreFocusColumns(columns: readonly string[]): boolean {
  if (columns.length === 0) return false;
  return !FOCUS_SENTINEL_COLUMNS.every(c => columns.includes(c));
}

/** Scan each provider tree under `dataDir` and return the provider directory
 *  names whose newest raw parquet is a pre-FOCUS (v0.6.x CUR 2.0) shape.
 *  `describeColumns` returns a read_parquet glob's column names (injected so
 *  this is testable without DuckDB). Empty when the data is already FOCUS or
 *  there is none (a fresh install) — so it never fires spuriously. */
export async function findPreFocusProviders(
  dataDir: string,
  describeColumns: (parquetGlob: string) => Promise<readonly string[]>,
): Promise<string[]> {
  let providerDirs: string[];
  try {
    const entries = await readdir(dataDir, { withFileTypes: true });
    providerDirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return []; // no data dir yet → fresh install
  }

  // Probe providers in parallel — the schema DESCRIBEs are independent, and
  // this runs on the pre-window boot path where the common (all-FOCUS) case
  // still pays one probe per provider.
  const flags = await Promise.all(providerDirs.map(async (provider): Promise<boolean> => {
    const rawDir = join(dataDir, provider, 'raw');
    let rawEntries: string[];
    try {
      rawEntries = await readdir(rawDir);
    } catch {
      return false; // not a provider tree (no raw/)
    }
    const newestPeriodDir = rawEntries.filter(e => RAW_PERIOD_DIR_RE.test(e)).sort().at(-1);
    if (newestPeriodDir === undefined) return false; // no FOCUS-billing data on disk

    try {
      // Forward slashes for the DuckDB glob: `join()` yields backslashes on
      // Windows, which the globber does not treat as separators — the DESCRIBE
      // would fail there and silently disable this detection on the one
      // platform whose upgrades most need it (same idiom as rollup-store).
      const columns = await describeColumns(join(rawDir, newestPeriodDir, '*.parquet').replaceAll('\\', '/'));
      return isPreFocusColumns(columns);
    } catch {
      // A parquet we can't even describe (transient read error, locked file) is
      // not grounds to nuke — skip it rather than risk deleting readable data.
      return false;
    }
  }));

  return providerDirs.filter((_, i) => flags[i] === true);
}

/** Delete the given providers' on-disk trees and the config file, so the app
 *  boots into the setup wizard (setup:status keys off the config's existence).
 *  Called only after the user confirms the wipe. */
export async function clearPreFocusData(
  dataDir: string,
  configPath: string,
  providers: readonly string[],
): Promise<void> {
  for (const provider of providers) {
    await rm(join(dataDir, provider), { recursive: true, force: true });
  }
  await rm(configPath, { force: true });
}
