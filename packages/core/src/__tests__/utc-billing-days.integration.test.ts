import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildRollupPartitionQuery,
  buildSource,
  buildTrendQuery,
  sqlStringLiteral,
} from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { asDateString, asDimensionId, asDollars, asHourString, asProviderName } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import type { DateRange } from '../types/query.js';

/**
 * Billing days are UTC days, whatever time zone the machine runs in.
 *
 * AWS Data Exports write ChargePeriodStart as a Parquet timestamp with
 * isAdjustedToUTC=1, which DuckDB reads as TIMESTAMP WITH TIME ZONE, and a
 * daily-granularity row can start at any hour. `::DATE` on that resolves in
 * the session time zone, which DuckDB takes from the process: east of UTC a
 * 23:00 UTC row moved to the next day, west of it a 05:00 UTC row to the day
 * before. A cost query reading only the range's own month, a trend query also
 * reading the previous period's month, and a rollup partition keeping only its
 * own month then each counted a different set of rows.
 *
 * Each instance below is created in a different zone, as the app's DuckDB
 * inherits the user's.
 */

const PROVIDER = asProviderName('aws');
const EC2 = 'Amazon Elastic Compute Cloud';
const ZONES = ['America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo', 'UTC'] as const;

// One power of two per row, so every total names exactly the rows it counts.
// `start` is UTC; the comment says where the session-zone day used to put it.
const ROWS = [
  { month: '2026-09', start: '2026-09-16 23:00:00', cost: 1 },   // east: 09-17, into the previous period
  { month: '2026-09', start: '2026-09-17 00:00:00', cost: 2 },   // west: 09-16, out of the previous period
  { month: '2026-09', start: '2026-09-30 23:00:00', cost: 4 },   // east: 10-01, into the range, out of September's partition
  { month: '2026-10', start: '2026-10-01 00:00:00', cost: 8 },   // west: 09-30, out of the range and of October's partition
  { month: '2026-10', start: '2026-10-01 05:00:00', cost: 16 },  // west: 09-30
  { month: '2026-10', start: '2026-10-14 23:00:00', cost: 32 },  // east: 10-15, out of the range
  { month: '2026-10', start: '2026-10-15 03:00:00', cost: 64 },  // west: 10-14, into the range
  { month: '2026-10', start: '2026-10-15 23:00:00', cost: 128 }, // east: 10-16
] as const;
const MONTHS = ['2026-09', '2026-10'] as const;

/** The range, and the previous period a trend compares it with (09-17..09-30). */
const RANGE: DateRange = { start: asDateString('2026-10-01'), end: asDateString('2026-10-14') };
const IN_RANGE = 8 + 16 + 32;
const IN_PREVIOUS = 2 + 4;

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
  ],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };
const service = asDimensionId('service');

/** Positional $1..$n binding, mirroring the duckdb-worker's. */
async function runPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const stmt = await conn.prepare(sql);
  try {
    params.forEach((value, i) => {
      if (typeof value === 'string') stmt.bindVarchar(i + 1, value);
      else if (typeof value === 'number' && Number.isInteger(value)) stmt.bindInteger(i + 1, value);
      else if (typeof value === 'number') stmt.bindDouble(i + 1, value);
      else throw new Error(`unexpected query parameter ${String(value)}`);
    });
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJson();
  } finally {
    stmt.destroySync();
  }
}

async function rowsOf(conn: DuckDBConnection, sql: string): Promise<Record<string, unknown>[]> {
  return (await conn.runAndReadAll(sql)).getRowObjectsJson();
}

/** `key → cost` from rows carrying a text key and a cost. */
function costsBy(rows: readonly Record<string, unknown>[], key: string, cost = 'cost'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r[key])] = (out[String(r[key])] ?? 0) + Number(r[cost]);
  return out;
}

function parquetList(paths: readonly string[]): string {
  return `read_parquet([${paths.map(p => sqlStringLiteral(p)).join(', ')}])`;
}

let dataDir: string;

beforeAll(async () => {
  dataDir = (await mkdtemp(join(tmpdir(), 'cg-utc-days-'))).replaceAll('\\', '/');
  const db = await DuckDBInstance.create();
  const conn = await db.connect();
  try {
    for (const tier of ['daily', 'hourly'] as const) {
      for (const month of MONTHS) {
        const dir = join(dataDir, String(PROVIDER), 'raw', `${tier}-${month}`);
        await mkdir(dir, { recursive: true });
        // Written with an explicit +00 offset, so the instant does not depend
        // on this instance's zone; the column is tz-aware, as AWS writes it.
        const values = ROWS.filter(r => r.month === month).map(r =>
          `(TIMESTAMPTZ '${r.start}+00', '111', 'Prod', 'eu-west-1', '${EC2}', 'AmazonEC2', 'Compute', 'usage',
            1.0, ${String(r.cost)}::DOUBLE, 'arn:res', ${String(r.cost)}::DOUBLE, ${String(r.cost)}::DOUBLE,
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
    }
  } finally {
    conn.disconnectSync();
    db.closeSync();
  }
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe.each(ZONES)('billing days with the DuckDB session in %s', (zone) => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let rollupDir: string;
  let rollupFiles: string[];
  const opts = (): QueryContextOptions => ({
    dataDir, dimensions, costScope,
    providers: [{ name: PROVIDER, availablePeriods: [...MONTHS] }],
  });
  const rawSource = (tier: 'daily' | 'hourly'): string =>
    buildSource({ dataDir, tier, dimensions, providers: [{ name: PROVIDER, periods: [...MONTHS] }], costMetric: 'effective' });

  beforeAll(async () => {
    db = await DuckDBInstance.create(':memory:', { TimeZone: zone });
    conn = await db.connect();
    rollupDir = (await mkdtemp(join(tmpdir(), 'cg-utc-days-rollup-'))).replaceAll('\\', '/');
    rollupFiles = [];
    for (const month of MONTHS) {
      const dir = join(rollupDir, `daily-${month}`);
      await mkdir(dir, { recursive: true });
      const file = join(dir, 'rollup.parquet').replaceAll('\\', '/');
      await conn.run(buildRollupPartitionQuery(month, 'daily', file, { ...opts(), providers: [{ name: PROVIDER, availablePeriods: [month] }] }));
      rollupFiles.push(file);
    }
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(rollupDir, { recursive: true, force: true });
  });

  it('runs in that zone, on tz-aware timestamps', async () => {
    const [row] = await rowsOf(conn, `SELECT current_setting('TimeZone') AS tz, typeof(ChargePeriodStart) AS t FROM read_parquet(${sqlStringLiteral(`${dataDir}/aws/raw/daily-2026-09/data.parquet`)}) LIMIT 1`);
    expect(row).toEqual({ tz: zone, t: 'TIMESTAMP WITH TIME ZONE' });
  });

  it('dates every raw row by its UTC day', async () => {
    const rows = await rowsOf(conn, `SELECT usage_date::VARCHAR AS day, cost FROM ${rawSource('daily')}`);
    expect(costsBy(rows, 'day')).toEqual({
      '2026-09-16': 1, '2026-09-17': 2, '2026-09-30': 4, '2026-10-01': 8 + 16, '2026-10-14': 32, '2026-10-15': 64 + 128,
    });
  });

  it('stamps every hourly row with its UTC hour', async () => {
    const rows = await rowsOf(conn, `SELECT usage_hour::VARCHAR AS hour, usage_date::VARCHAR AS day, cost FROM ${rawSource('hourly')} ORDER BY cost`);
    expect(rows.map(r => [r['hour'], r['day']])).toEqual(ROWS.map(r => [r.start, r.start.slice(0, 10)]));
  });

  it('costs the range with the rows of its UTC days', async () => {
    const q = buildCostQuery({ groupBy: service, dateRange: RANGE, filters: {} }, opts());
    expect(costsBy(await runPrepared(conn, q.sql, q.params), 'entity', 'total_cost')).toEqual({ [EC2]: IN_RANGE });
  });

  it('trends the same current period, against the UTC previous one', async () => {
    const q = buildTrendQuery({ groupBy: service, dateRange: RANGE, filters: {}, deltaThreshold: asDollars(0), percentThreshold: 0 }, opts());
    const rows = await runPrepared(conn, q.sql, q.params);
    expect(rows.map(r => [r['entity'], Number(r['current_cost']), Number(r['previous_cost'])])).toEqual([[EC2, IN_RANGE, IN_PREVIOUS]]);
  });

  it('puts the daily series on UTC days', async () => {
    const q = buildDailyCostsQuery({ groupBy: service, dateRange: RANGE, filters: {} }, opts());
    expect(costsBy(await runPrepared(conn, q.sql, q.params), 'date')).toEqual({ '2026-10-01': 8 + 16, '2026-10-14': 32 });
  });

  it('puts the hourly series on UTC hours', async () => {
    const q = buildDailyCostsQuery({ groupBy: service, dateRange: RANGE, filters: {}, granularity: 'hourly' }, opts());
    expect(costsBy(await runPrepared(conn, q.sql, q.params), 'date')).toEqual({
      '2026-10-01 00:00': 8, '2026-10-01 05:00': 16, '2026-10-14 23:00': 32,
    });
  });

  it('bounds an hour range by UTC hours', async () => {
    const lastHour = asHourString('2026-10-14 23:00:00');
    const q = buildCostQuery({ groupBy: service, dateRange: { ...RANGE, startHour: lastHour, endHour: lastHour }, filters: {} }, opts());
    expect(costsBy(await runPrepared(conn, q.sql, q.params), 'entity', 'total_cost')).toEqual({ [EC2]: 32 });
  });

  it('keeps every row in the rollup partition of its UTC month', async () => {
    const byMonth = await Promise.all(rollupFiles.map(async file =>
      costsBy(await rowsOf(conn, `SELECT usage_date::VARCHAR AS day, cost FROM read_parquet(${sqlStringLiteral(file)})`), 'day')));
    expect(byMonth).toEqual([
      { '2026-09-16': 1, '2026-09-17': 2, '2026-09-30': 4 },
      { '2026-10-01': 8 + 16, '2026-10-14': 32, '2026-10-15': 64 + 128 },
    ]);
  });

  it('answers the cost, trend and daily queries from the rollup as from raw', async () => {
    const fromRollup = { ...opts(), materializedSource: parquetList(rollupFiles) };
    const cost = buildCostQuery({ groupBy: service, dateRange: RANGE, filters: {} }, fromRollup);
    expect(costsBy(await runPrepared(conn, cost.sql, cost.params), 'entity', 'total_cost')).toEqual({ [EC2]: IN_RANGE });

    const trend = buildTrendQuery({ groupBy: service, dateRange: RANGE, filters: {}, deltaThreshold: asDollars(0), percentThreshold: 0 }, fromRollup);
    expect((await runPrepared(conn, trend.sql, trend.params)).map(r => [Number(r['current_cost']), Number(r['previous_cost'])])).toEqual([[IN_RANGE, IN_PREVIOUS]]);

    const daily = buildDailyCostsQuery({ groupBy: service, dateRange: RANGE, filters: {} }, fromRollup);
    expect(costsBy(await runPrepared(conn, daily.sql, daily.params), 'date')).toEqual({ '2026-10-01': 8 + 16, '2026-10-14': 32 });
  });
});
