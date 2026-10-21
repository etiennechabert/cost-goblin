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
  for (const date of dates) {
    let files: string[];
    try {
      files = await readdir(join(rawDir, `cost-opt-${date}`));
    } catch {
      continue;
    }
    if (files.some(f => f.endsWith('.parquet'))) return { providerName: String(provider), date };
  }
  return null;
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

/** Every recommendation of each provider's latest snapshot. A provider whose
 *  snapshot can't be read is left out (and logged) rather than failing the
 *  others; two providers syncing the same export list each recommendation once. */
export async function loadSavingsRecommendations(
  dataDir: string,
  providers: readonly ProviderConfig[],
  runQuery: (sql: string) => Promise<readonly Row[]>,
): Promise<LoadedSavings> {
  const recommendations: SavingsRecommendation[] = [];
  const snapshots: SavingsSnapshot[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (provider.sync.costOptimization === undefined) continue;
    const snapshot = await latestCostOptSnapshot(dataDir, provider.name);
    if (snapshot === null) continue;
    let rows: readonly Row[];
    try {
      rows = await runQuery(buildSavingsQuery(dataDir, provider.name, snapshot.date));
    } catch (err: unknown) {
      logger.warn(`savings: cannot read ${String(provider.name)} cost-opt-${snapshot.date}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    snapshots.push(snapshot);
    for (const row of rows) {
      const rec = parseSavingsRow(row, String(provider.name));
      if (rec.recommendationId !== '') {
        if (seen.has(rec.recommendationId)) continue;
        seen.add(rec.recommendationId);
      }
      recommendations.push(rec);
    }
  }
  return { recommendations, snapshots };
}
