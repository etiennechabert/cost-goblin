import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrendQuery } from '../query/builder.js';
import { trendPercentChange, trendPercentChangeSql } from '../query/trend-change.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import { asDateString, asDimensionId, asDollars, asProviderName } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';

/**
 * The trend query's `percent_change` and `trendPercentChange` are twins: SQL
 * reports the change per entity, and JS recomputes it once rows are merged
 * (account names sharing an id, the Trends view netting its two buckets).
 * Both run here on real DuckDB, so changing one without the other fails.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' },
  ],
  tags: [],
};
const providers = [{ name: asProviderName(FIXTURE_PROVIDER_NAME), availablePeriods: ['2026-01', '2026-02'] }];

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
    return reader.getRowObjects();
  } finally {
    stmt.destroySync();
  }
}

function num(row: Record<string, unknown> | undefined, column: string): number {
  const value = row?.[column];
  if (typeof value !== 'number') throw new Error(`${column} is not a number: ${String(value)}`);
  return value;
}

describe('trend percent change (DuckDB execution)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  it('SQL and JS agree, including from a $0 previous period', async () => {
    const cases: readonly (readonly [number, number])[] = [
      [150, 100], [25, 100], [0, 100], [29.25, 1.46], [250, 0], [-75, 0], [1.08, 0], [0, 0],
    ];
    const values = cases.map(([c, p]) => `(${String(c)}::DOUBLE, ${String(p)}::DOUBLE)`).join(', ');
    const rows = await runPrepared(
      conn,
      `SELECT c, p, ${trendPercentChangeSql('c', 'p')} AS pct FROM (VALUES ${values}) AS t(c, p)`,
      [],
    );
    expect(rows).toHaveLength(cases.length);
    for (const r of rows) {
      expect(num(r, 'pct')).toBe(trendPercentChange(num(r, 'c'), num(r, 'p')));
    }
  });

  it('reports an entity new this period as ±100 instead of NULL', async () => {
    // The monthly Tax charge and EC2 credit land on the 1st, so for 1–2 Feb
    // neither has any cost in the previous period (30–31 Jan).
    const { sql, params } = buildTrendQuery(
      {
        groupBy: asDimensionId('charge_category'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-02') },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      { dataDir: SYNTHETIC_DIR, dimensions, providers },
    );
    const rows = await runPrepared(conn, sql, params);
    const byEntity = new Map(rows.map((r): [unknown, Record<string, unknown>] => [r['entity'], r]));

    expect(num(byEntity.get('Tax'), 'previous_cost')).toBe(0);
    expect(num(byEntity.get('Tax'), 'percent_change')).toBe(100);
    expect(num(byEntity.get('Credit'), 'previous_cost')).toBe(0);
    expect(num(byEntity.get('Credit'), 'percent_change')).toBe(-100);
    // No cost in either period: no change, not new.
    expect(num(byEntity.get('Purchase'), 'percent_change')).toBe(0);

    for (const r of rows) {
      expect(num(r, 'percent_change')).toBe(trendPercentChange(num(r, 'current_cost'), num(r, 'previous_cost')));
    }
  });

  it('matches the JS change on every entity of a window with prior spend', async () => {
    const { sql, params } = buildTrendQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-14') },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      { dataDir: SYNTHETIC_DIR, dimensions, providers },
    );
    const rows = await runPrepared(conn, sql, params);
    expect(rows.length).toBeGreaterThan(5);
    for (const r of rows) {
      expect(num(r, 'percent_change')).toBe(trendPercentChange(num(r, 'current_cost'), num(r, 'previous_cost')));
    }
  });
});
