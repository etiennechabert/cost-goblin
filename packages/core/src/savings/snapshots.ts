import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { sqlStringLiteral } from '../query/sql-escape.js';
import { providerRawDir } from '../sync/provider-paths.js';
import type { ProviderName } from '../types/branded.js';
import type { ProviderConfig } from '../types/config.js';
import type { SavingsRecommendation, SavingsSnapshot } from '../types/query.js';
import { parseSavingsRow } from './coh-rows.js';

// The Cost Optimization Hub export writes a complete list of current
// recommendations every day (`date=YYYY-MM-DD/`, synced to
// `raw/cost-opt-YYYY-MM-DD/`). Only the newest day is current: a
// recommendation missing from it was implemented or superseded, so reading
// older days too would bring it back. Old syncs used `cost-opt-YYYY-MM/`.

const SNAPSHOT_DIR = /^cost-opt-(\d{4}-\d{2}(?:-\d{2})?)$/;
const SNAPSHOT_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;

type Row = Readonly<Record<string, unknown>>;

/** Newest first: `YYYY-MM-DD` and `YYYY-MM` sort as strings. */
function newestFirst(a: string, b: string): number {
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

/** The newest `cost-opt-*` directory of `provider` that holds a Parquet file. */
export async function latestCostOptSnapshot(dataDir: string, provider: ProviderName): Promise<SavingsSnapshot | null> {
  const rawDir = providerRawDir(dataDir, provider);
  let names: string[];
  try {
    names = await readdir(rawDir);
  } catch {
    return null; // nothing synced yet
  }
  const dates = names
    .map(name => SNAPSHOT_DIR.exec(name)?.[1])
    .filter((date): date is string => date !== undefined)
    .sort(newestFirst);
  // An empty directory (an interrupted download) is no snapshot.
  const populated = await Promise.all(dates.map(async date => {
    try {
      return (await readdir(join(rawDir, `cost-opt-${date}`))).some(f => f.endsWith('.parquet'));
    } catch {
      return false; // not a directory, or gone mid-scan
    }
  }));
  const date = dates.find((_, i) => populated[i] === true);
  return date === undefined ? null : { providerName: String(provider), date };
}

/** SELECT one snapshot's recommendations, aliased for `parseSavingsRow`. */
export function buildSavingsQuery(dataDir: string, provider: ProviderName, date: string): string {
  if (!SNAPSHOT_DATE.test(date)) throw new Error(`Not a cost optimization snapshot date: ${date}`);
  const glob = sqlStringLiteral(`${dataDir}/${String(provider)}/raw/cost-opt-${date}/*.parquet`);
  return `
    SELECT
      COALESCE(recommendation_id, '') AS recommendation_id,
      COALESCE(account_id, '') AS account_id,
      COALESCE(account_name, '') AS account_name,
      COALESCE(action_type, '') AS action_type,
      COALESCE(current_resource_type, '') AS current_resource_type,
      COALESCE(recommended_resource_summary, '') AS summary,
      COALESCE(region, '') AS region,
      CAST(COALESCE(estimated_monthly_savings_after_discount, 0) AS DOUBLE) AS monthly_savings,
      CAST(COALESCE(estimated_monthly_cost_after_discount, 0) AS DOUBLE) AS monthly_cost,
      CAST(COALESCE(estimated_savings_percentage_after_discount, 0) AS DOUBLE) AS savings_pct,
      COALESCE(implementation_effort, '') AS effort,
      COALESCE(resource_arn, '') AS resource_arn,
      COALESCE(current_resource_details, '') AS current_details,
      COALESCE(recommended_resource_details, '') AS recommended_details,
      COALESCE(current_resource_summary, '') AS current_summary,
      COALESCE(restart_needed, false) AS restart_needed,
      COALESCE(rollback_possible, false) AS rollback_possible,
      COALESCE(recommendation_source, '') AS recommendation_source
    FROM read_parquet(${glob}, union_by_name=true, filename=true)
    QUALIFY recommendation_id IS NULL OR ROW_NUMBER() OVER (PARTITION BY recommendation_id ORDER BY filename DESC) = 1
    ORDER BY monthly_savings DESC, recommendation_id
  `;
}

export interface LoadedSavings {
  readonly recommendations: readonly SavingsRecommendation[];
  readonly snapshots: readonly SavingsSnapshot[];
}

interface ProviderSnapshot {
  readonly snapshot: SavingsSnapshot;
  readonly recommendations: readonly SavingsRecommendation[];
  /** The COH export the provider syncs: its cost-optimization bucket path. */
  readonly exportKey: string;
}

/** `s3://bucket/prefix` with no trailing slash, so `prefix/` and `prefix` match. */
function exportKeyOf(bucket: string): string {
  let end = bucket.length;
  while (end > 0 && bucket[end - 1] === '/') end -= 1;
  return bucket.slice(0, end);
}

async function readProviderSnapshot(
  dataDir: string,
  provider: ProviderName,
  exportKey: string,
  runQuery: (sql: string) => Promise<readonly Row[]>,
): Promise<ProviderSnapshot | null> {
  const snapshot = await latestCostOptSnapshot(dataDir, provider);
  if (snapshot === null) return null;
  try {
    const rows = await runQuery(buildSavingsQuery(dataDir, provider, snapshot.date));
    return { snapshot, recommendations: rows.map(row => parseSavingsRow(row, String(provider))), exportKey };
  } catch (err: unknown) {
    logger.warn(`savings: cannot read ${String(provider)} cost-opt-${snapshot.date}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Every recommendation of each provider's latest snapshot. A provider whose
 *  snapshot can't be read is left out (and logged) rather than failing the
 *  others. Two providers whose cost-optimization tier points at the same
 *  bucket path sync the same export: only the newest snapshot is read, or the
 *  older one would bring back what has since been implemented. Different
 *  exports can still share recommendations (a member account's own export
 *  next to the payer's): each is listed once, from the newer snapshot. */
export async function loadSavingsRecommendations(
  dataDir: string,
  providers: readonly ProviderConfig[],
  runQuery: (sql: string) => Promise<readonly Row[]>,
): Promise<LoadedSavings> {
  const read = await Promise.all(providers.flatMap(provider => {
    const tier = provider.sync.costOptimization;
    return tier === undefined ? [] : [readProviderSnapshot(dataDir, provider.name, exportKeyOf(String(tier.bucket)), runQuery)];
  }));
  // Newest snapshot first; a stable sort keeps the config order on a tie.
  const newestFirstRead = read
    .filter((r): r is ProviderSnapshot => r !== null)
    .sort((a, b) => newestFirst(a.snapshot.date, b.snapshot.date));

  const recommendations: SavingsRecommendation[] = [];
  const snapshots: SavingsSnapshot[] = [];
  const seenExports = new Set<string>();
  const seen = new Set<string>();
  for (const { snapshot, recommendations: recs, exportKey } of newestFirstRead) {
    if (seenExports.has(exportKey)) {
      logger.info(`savings: ${snapshot.providerName} syncs the same Cost Optimization Hub export as a provider with a newer snapshot; skipping its cost-opt-${snapshot.date}`);
      continue;
    }
    seenExports.add(exportKey);
    const fresh = recs.filter(r => r.recommendationId === '' || !seen.has(r.recommendationId));
    for (const rec of recs) if (rec.recommendationId !== '') seen.add(rec.recommendationId);
    snapshots.push(snapshot);
    recommendations.push(...fresh);
  }
  return { recommendations, snapshots };
}
