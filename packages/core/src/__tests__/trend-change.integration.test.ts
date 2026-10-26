import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTrendQuery } from '../query/builder.js';
import type { ProviderSourceSpec } from '../query/builder.js';
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
const providers: ProviderSourceSpec[] = [{ name: asProviderName(FIXTURE_PROVIDER_NAME), type: 'aws', availablePeriods: ['2026-01', '2026-02'] }];

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

  /** The trend query over the synthetic fixtures, with no threshold applied. */
  async function trendRows(groupBy: string, start: string, end: string): Promise<Record<string, unknown>[]> {
    const { sql, params } = buildTrendQuery(
      {
        groupBy: asDimensionId(groupBy),
        dateRange: { start: asDateString(start), end: asDateString(end) },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      { dataDir: SYNTHETIC_DIR, dimensions, providers },
    );
    return runPrepared(conn, sql, params);
  }

  function expectPercentMatchesJs(rows: readonly Record<string, unknown>[]): void {
    for (const r of rows) {
      expect(num(r, 'percent_change')).toBe(trendPercentChange(num(r, 'current_cost'), num(r, 'previous_cost')));
    }
  }

  it('SQL and JS agree, including from a $0 or net-credit previous period', async () => {
    const cases: readonly (readonly [number, number])[] = [
      [150, 100], [25, 100], [0, 100], [29.25, 1.46], [250, 0], [-75, 0], [1.08, 0], [0, 0],
      [-150, -100], [-50, -100], [0, -100], [50, -100], [-12.34, -56.78],
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
    const rows = await trendRows('charge_category', '2026-02-01', '2026-02-02');
    const byEntity = new Map(rows.map((r): [unknown, Record<string, unknown>] => [r['entity'], r]));

    expect(num(byEntity.get('Tax'), 'previous_cost')).toBe(0);
    expect(num(byEntity.get('Tax'), 'percent_change')).toBe(100);
    expect(num(byEntity.get('Credit'), 'previous_cost')).toBe(0);
    expect(num(byEntity.get('Credit'), 'percent_change')).toBe(-100);
    // No cost in either period: no change, not new.
    expect(num(byEntity.get('Purchase'), 'percent_change')).toBe(0);

    expectPercentMatchesJs(rows);
  });

  it('reports a credit that ended as an increase, signed like its delta', async () => {
    // For 2–28 Feb the previous period (6 Jan – 1 Feb) holds the February
    // credit and the current period none: net cost rose from -$75 to $0.
    const rows = await trendRows('charge_category', '2026-02-02', '2026-02-28');
    const credit = rows.find(r => r['entity'] === 'Credit');

    expect(num(credit, 'previous_cost')).toBe(-75);
    expect(num(credit, 'current_cost')).toBe(0);
    expect(num(credit, 'delta')).toBe(75);
    expect(num(credit, 'percent_change')).toBe(100);

    expectPercentMatchesJs(rows);
  });

  it('matches the JS change on every entity of a window with prior spend', async () => {
    const rows = await trendRows('service', '2026-02-01', '2026-02-14');
    expect(rows.length).toBeGreaterThan(5);
    expectPercentMatchesJs(rows);
  });
});
