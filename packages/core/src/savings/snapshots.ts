import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../logger/logger.js';
import { type NullableColumn, withNullableColumns } from '../query/provider-projection.js';
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

/** The export columns the query reads, each as `parseSavingsRow` reads it
 *  (`alias`), with the type AWS writes it in. AWS Data Exports lets an export
 *  pick its columns, and the one our CloudFormation stack creates leaves out
 *  `account_name`: a column missing from every file is a binder error, which
 *  left the whole snapshot unread. So every column reads NULL when absent. */
const SAVINGS_COLUMNS: readonly (NullableColumn & { readonly alias?: string })[] = [
  { name: 'recommendation_id', type: 'VARCHAR' },
  { name: 'account_id', type: 'VARCHAR' },
  { name: 'account_name', type: 'VARCHAR' },
  { name: 'action_type', type: 'VARCHAR' },
  { name: 'current_resource_type', type: 'VARCHAR' },
  { name: 'recommended_resource_summary', type: 'VARCHAR', alias: 'summary' },
  { name: 'region', type: 'VARCHAR' },
  { name: 'estimated_monthly_savings_after_discount', type: 'DOUBLE', alias: 'monthly_savings' },
  { name: 'estimated_monthly_cost_after_discount', type: 'DOUBLE', alias: 'monthly_cost' },
  { name: 'estimated_savings_percentage_after_discount', type: 'DOUBLE', alias: 'savings_pct' },
  { name: 'implementation_effort', type: 'VARCHAR', alias: 'effort' },
  { name: 'resource_arn', type: 'VARCHAR' },
  { name: 'current_resource_details', type: 'VARCHAR', alias: 'current_details' },
  { name: 'recommended_resource_details', type: 'VARCHAR', alias: 'recommended_details' },
  { name: 'current_resource_summary', type: 'VARCHAR', alias: 'current_summary' },
  { name: 'restart_needed', type: 'BOOLEAN' },
  { name: 'rollback_possible', type: 'BOOLEAN' },
  { name: 'recommendation_source', type: 'VARCHAR' },
];

/** A column read with its type's empty value in place of NULL. */
function selectColumn(column: NullableColumn & { readonly alias?: string }): string {
  const alias = column.alias ?? column.name;
  switch (column.type) {
    case 'VARCHAR': return `COALESCE(${column.name}, '') AS ${alias}`;
    case 'DOUBLE': return `CAST(COALESCE(${column.name}, 0) AS DOUBLE) AS ${alias}`;
    case 'BOOLEAN': return `COALESCE(${column.name}, false) AS ${alias}`;
  }
}

/** SELECT one snapshot's recommendations, aliased for `parseSavingsRow`. */
export function buildSavingsQuery(dataDir: string, provider: ProviderName, date: string): string {
  if (!SNAPSHOT_DATE.test(date)) throw new Error(`Not a cost optimization snapshot date: ${date}`);
  const glob = sqlStringLiteral(`${dataDir}/${String(provider)}/raw/cost-opt-${date}/*.parquet`);
  const source = withNullableColumns(`read_parquet(${glob}, union_by_name=true, filename=true)`, SAVINGS_COLUMNS);
  return `
    SELECT
      ${SAVINGS_COLUMNS.map(selectColumn).join(',\n      ')}
    FROM ${source}
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

/** The name an account shows under: the account map's (org accounts or the
 *  account CSV, as every other view names it), else the export's own, else
 *  the id. An export without `account_name` leaves only the id. */
function namedAccount(rec: SavingsRecommendation, accountNames: ReadonlyMap<string, string>): SavingsRecommendation {
  const name = accountNames.get(rec.accountId) ?? (rec.accountName === '' ? rec.accountId : rec.accountName);
  return name === rec.accountName ? rec : { ...rec, accountName: name };
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
  accountNames: ReadonlyMap<string, string> = new Map(),
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
    recommendations.push(...fresh.map(r => namedAccount(r, accountNames)));
  }
  return { recommendations, snapshots };
}
