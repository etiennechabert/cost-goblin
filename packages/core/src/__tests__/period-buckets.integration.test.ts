import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDailyCostsQuery, buildEntityDetailQuery, usageDateBucketExpr } from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import { asDateString, asDimensionId, asEntityRef, asProviderName } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';
import type { DateRange, Granularity } from '../types/query.js';

/**
 * Weekly and monthly buckets over the synthetic daily tier: every row lands in
 * the bucket keyed by its period's first day (ISO Monday, or the 1st), totals
 * match the daily rows to the cent, and the keys do not move with the DuckDB
 * session's time zone.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PROVIDER = asProviderName(FIXTURE_PROVIDER_NAME);

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [],
};
const opts: QueryContextOptions = { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, type: 'aws' }] };

// Jan 1 2026 is a Thursday, so the first weekly bucket starts in December.
const RANGE: DateRange = { start: asDateString('2026-01-01'), end: asDateString('2026-02-28') };
const service = asDimensionId('service');

/** Positional $1..$n binding, mirroring the duckdb-worker's. */
async function runPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const stmt = await conn.prepare(sql);
  try {
    params.forEach((value, i) => {
      if (typeof value === 'string') stmt.bindVarchar(i + 1, value);
      else throw new Error(`unexpected query parameter ${String(value)}`);
    });
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJson();
  } finally {
    stmt.destroySync();
  }
}

function totalCost(rows: readonly Record<string, unknown>[]): number {
  return rows.reduce((total, row) => total + Number(row['cost']), 0);
}

/** Rows tied on cost come back in no fixed order, so compare them sorted. */
function byKey(rows: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const key = (row: Record<string, unknown>): string => `${String(row['date'])}|${String(row['group_name'])}`;
  return [...rows].sort((a, b) => key(a).localeCompare(key(b)));
}

describe('weekly and monthly period buckets', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterEach(async () => {
    await conn.run("SET TimeZone = 'UTC'");
  });

  afterAll(() => {
    conn.closeSync();
    db.closeSync();
  });

  async function dailyCosts(granularity: Granularity): Promise<Record<string, unknown>[]> {
    const q = buildDailyCostsQuery({ groupBy: service, dateRange: RANGE, filters: {}, granularity }, opts);
    return runPrepared(conn, q.sql, q.params);
  }

  it('maps each granularity to its truncation expression', () => {
    expect(usageDateBucketExpr(undefined)).toBe('usage_date');
    expect(usageDateBucketExpr('daily')).toBe('usage_date');
    expect(usageDateBucketExpr('weekly')).toBe("CAST(date_trunc('week', usage_date) AS DATE)");
    expect(usageDateBucketExpr('monthly')).toBe("CAST(date_trunc('month', usage_date) AS DATE)");
  });

  it('buckets daily costs by ISO week start', async () => {
    const daily = await dailyCosts('daily');
    const weekly = await dailyCosts('weekly');
    expect(weekly.length).toBeGreaterThan(0);
    const dates = [...new Set(weekly.map(r => String(r['date'])))];
    for (const date of dates) {
      expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    expect(dates).toContain('2025-12-29');
    expect(totalCost(weekly)).toBeCloseTo(totalCost(daily), 2);
  });

  it('buckets daily costs by month start', async () => {
    const daily = await dailyCosts('daily');
    const monthly = await dailyCosts('monthly');
    const dates = [...new Set(monthly.map(r => String(r['date'])))].sort();
    expect(dates).toEqual(['2026-01-01', '2026-02-01']);
    for (const date of dates) expect(date.endsWith('-01')).toBe(true);
    expect(totalCost(monthly)).toBeCloseTo(totalCost(daily), 2);
  });

  it('buckets entity detail by month', async () => {
    const [first] = await dailyCosts('monthly');
    const entity = String(first?.['group_name']);
    const q = buildEntityDetailQuery(
      { entity: asEntityRef(entity), dimension: service, dateRange: RANGE, filters: {}, granularity: 'monthly' },
      opts,
    );
    const rows = await runPrepared(conn, q.sql, q.params);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(String(row['usage_date']).endsWith('-01')).toBe(true);
  });

  it('keeps buckets in a non-UTC session', async () => {
    const utcRows = await dailyCosts('weekly');
    await conn.run("SET TimeZone = 'America/Los_Angeles'");
    const laRows = await dailyCosts('weekly');
    // Same buckets and groups; amounts compare to the cent, not bit for bit,
    // because DuckDB's SUM order (and so its float rounding) varies per run.
    const la = byKey(laRows);
    const utc = byKey(utcRows);
    expect(la.map(r => `${String(r['date'])}|${String(r['group_name'])}`)).toEqual(
      utc.map(r => `${String(r['date'])}|${String(r['group_name'])}`),
    );
    la.forEach((row, i) => {
      expect(Number(row['cost'])).toBeCloseTo(Number(utc[i]?.['cost']), 6);
    });
  });
});
