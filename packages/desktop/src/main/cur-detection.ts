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

/** Raw period-dir names the sync writes: `{tier}-YYYY-MM`, where the tier
 *  prefixes are `daily` / `hourly` / `cost-opt` (see TIER_RAW_PREFIXES). */
const RAW_PERIOD_DIR_RE = /^(?:daily|hourly|cost-opt)-\d{4}-(?:0[1-9]|1[0-2])$/;

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

  const preFocus: string[] = [];
  for (const provider of providerDirs) {
    const rawDir = join(dataDir, provider, 'raw');
    let rawEntries: string[];
    try {
      rawEntries = await readdir(rawDir);
    } catch {
      continue; // not a provider tree (no raw/)
    }
    const newestPeriodDir = rawEntries.filter(e => RAW_PERIOD_DIR_RE.test(e)).sort().at(-1);
    if (newestPeriodDir === undefined) continue; // no data on disk for this provider

    let columns: readonly string[];
    try {
      columns = await describeColumns(join(rawDir, newestPeriodDir, '*.parquet'));
    } catch {
      // A parquet we can't even describe (transient read error, locked file) is
      // not grounds to nuke — skip it rather than risk deleting readable data.
      continue;
    }
    if (isPreFocusColumns(columns)) preFocus.push(provider);
  }
  return preFocus;
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
