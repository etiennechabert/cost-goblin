import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sqlStringLiteral } from '../../query/builder.js';

/**
 * A raw tree whose billing-period files hold rows of other months, as real
 * exports do: January's file has a day of December, two of February and one
 * of March; March's has a day of February and one of April. February and
 * December have no file of their own.
 *
 * Every cost is a different power of two, so a total names the rows it counts,
 * and `costByDay` gives what any range must return without reading a file.
 */

export interface FiledRow {
  /** The billing period (`YYYY-MM`) whose file holds the row. */
  readonly period: string;
  /** ChargePeriodStart, UTC. */
  readonly start: string;
  readonly cost: number;
  /** Names the row's resource (`arn:<pair>`) and description (`<pair> usage`). */
  readonly pair: string;
}

export const FILED_PERIODS: readonly string[] = ['2026-01', '2026-03'];

export const FILED_ROWS: readonly FiledRow[] = [
  { period: '2026-01', start: '2025-12-30 05:00:00', cost: 1, pair: 'early' },
  { period: '2026-01', start: '2026-01-10 00:00:00', cost: 2, pair: 'shared' },
  { period: '2026-01', start: '2026-01-31 23:00:00', cost: 4, pair: 'january' },
  { period: '2026-01', start: '2026-02-01 00:00:00', cost: 8, pair: 'january' },
  { period: '2026-01', start: '2026-02-15 12:00:00', cost: 16, pair: 'shared' },
  { period: '2026-01', start: '2026-03-02 00:00:00', cost: 32, pair: 'shared' },
  { period: '2026-03', start: '2026-02-27 00:00:00', cost: 64, pair: 'shared' },
  { period: '2026-03', start: '2026-03-02 08:00:00', cost: 128, pair: 'march' },
  { period: '2026-03', start: '2026-03-20 00:00:00', cost: 256, pair: 'march' },
  { period: '2026-03', start: '2026-04-01 03:00:00', cost: 512, pair: 'late' },
];

export const FILED_SERVICE = 'Amazon Elastic Compute Cloud';

/** The UTC days a period's file holds rows of, oldest first. */
export function filedDays(period: string): string[] {
  return [...new Set(FILED_ROWS.filter(r => r.period === period).map(r => r.start.slice(0, 10)))].sort((a, b) => a.localeCompare(b));
}

/** `day → cost` over the rows dated in the range, from every file. */
export function costByDay(range: { readonly start: string; readonly end: string }): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of FILED_ROWS) {
    const day = row.start.slice(0, 10);
    if (day >= range.start && day <= range.end) out[day] = (out[day] ?? 0) + row.cost;
  }
  return out;
}

/** The cost of every row dated in the range, from every file. */
export function costIn(range: { readonly start: string; readonly end: string }): number {
  return Object.values(costByDay(range)).reduce((sum, cost) => sum + cost, 0);
}

/** One EC2 usage line item, as AWS's FOCUS export shapes it. */
export interface AwsUsageRow {
  /** ChargePeriodStart, UTC. */
  readonly start: string;
  /** The row's list, effective and billed cost. */
  readonly cost: number;
  readonly resource: string;
  readonly description: string;
}

/** Writes `rows` to `{dir}/data.parquet`, AWS-shaped: a tz-aware
 *  ChargePeriodStart, written with an explicit offset so the instant does not
 *  depend on the connection's zone, and every column `buildSource` reads. */
export async function writeAwsUsageRows(conn: DuckDBConnection, dir: string, rows: readonly AwsUsageRow[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  const values = rows.map(r =>
    `(TIMESTAMPTZ '${r.start}+00', '111', 'Prod', 'eu-west-1', '${FILED_SERVICE}', 'AmazonEC2', 'Compute', '${r.description}',
      1.0, ${String(r.cost)}::DOUBLE, '${r.resource}', ${String(r.cost)}::DOUBLE, ${String(r.cost)}::DOUBLE,
      'Usage', 'Standard', '', 'RunInstances', 'BoxUsage', MAP {'team': 'core'})`);
  await conn.run(`
    COPY (
      SELECT * FROM (VALUES ${values.join(',\n')}) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
             ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
             ConsumedQuantity, ListCost, ResourceId, EffectiveCost, BilledCost,
             ChargeCategory, PricingCategory, CommitmentDiscountStatus,
             x_Operation, SkuMeter, Tags)
    ) TO ${sqlStringLiteral(join(dir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
  `);
}

/** Writes `FILED_ROWS` as `{dataDir}/{provider}/raw/{tier}-{period}/data.parquet`. */
export async function writeFiledRows(
  conn: DuckDBConnection,
  dataDir: string,
  provider: string,
  tiers: readonly ('daily' | 'hourly')[] = ['daily'],
): Promise<void> {
  for (const tier of tiers) {
    for (const period of FILED_PERIODS) {
      const rows = FILED_ROWS.filter(r => r.period === period)
        .map(r => ({ start: r.start, cost: r.cost, resource: `arn:${r.pair}`, description: `${r.pair} usage` }));
      await writeAwsUsageRows(conn, join(dataDir, provider, 'raw', `${tier}-${period}`), rows);
    }
  }
}
