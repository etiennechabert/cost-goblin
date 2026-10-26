import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asDateString, asDimensionId, asDollars, asEntityRef, asProviderName, buildTrendQuery } from '@costgoblin/core';
import type { DimensionsConfig, TrendResult, TrendRow } from '@costgoblin/core';
import { buildTrendResult, mergeTrendRowsByEntity } from '../main/handlers/query-utils.js';
import { fetchRowsPrepared } from './helpers/duckdb-rows.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic');
// Literal mirror of FIXTURE_PROVIDER_NAME in packages/core/src/__fixtures__/layout.ts
// (not importable here — outside this package's tsconfig rootDir).
const FIXTURE_PROVIDER = asProviderName('aws-main');

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' }],
  tags: [],
};

function trendRow(entity: string, currentCost: number, previousCost: number, percentChange: number): TrendRow {
  return {
    entity: asEntityRef(entity),
    currentCost: asDollars(currentCost),
    previousCost: asDollars(previousCost),
    delta: asDollars(currentCost - previousCost),
    percentChange,
  };
}

function find(rows: readonly TrendRow[], entity: string): TrendRow | undefined {
  return rows.find(r => r.entity === entity);
}

describe('buildTrendResult', () => {
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

  /** The trend rows DuckDB returns by charge category for 1–2 Feb 2026: the
   *  monthly Tax charge and EC2 credit land on the 1st, so neither has any
   *  cost in the previous period (30–31 Jan). */
  async function newSpendWindow(deltaThreshold: number, percentThreshold: number): Promise<TrendResult> {
    const { sql, params } = buildTrendQuery(
      {
        groupBy: asDimensionId('charge_category'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-02') },
        filters: {},
        deltaThreshold: asDollars(deltaThreshold),
        percentThreshold,
      },
      { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: FIXTURE_PROVIDER, type: 'aws', availablePeriods: ['2026-01', '2026-02'] }] },
    );
    return buildTrendResult(await fetchRowsPrepared(conn, sql, params), deltaThreshold, percentThreshold);
  }

  it('reports spend and credits new this period when a percent threshold is set', async () => {
    const result = await newSpendWindow(1, 5);
    expect(find(result.increases, 'Tax')).toMatchObject({ previousCost: 0, delta: 250, percentChange: 100 });
    expect(find(result.savings, 'Credit')).toMatchObject({ previousCost: 0, delta: -75, percentChange: -100 });
    expect(result.totalIncrease).toBeGreaterThanOrEqual(250);
    expect(result.totalSavings).toBe(75);
  });

  it('keeps them above any percent threshold, still applying it to entities with previous cost', async () => {
    const result = await newSpendWindow(1, 500);
    // Usage grew ~10%: below 500% and dropped. Tax and Credit are new.
    expect(result.increases.map(r => r.entity)).toEqual(['Tax']);
    expect(result.savings.map(r => r.entity)).toEqual(['Credit']);
  });

  it('does not report an entity with no cost in either period as new', async () => {
    // Purchase lines carry no effective cost in either period: a 0% change.
    const result = await newSpendWindow(0, 5);
    expect(find([...result.increases, ...result.savings], 'Purchase')).toBeUndefined();
  });
});

describe('mergeTrendRowsByEntity', () => {
  it('signs the ±100% of a merged entity new this period like its change', () => {
    const [credit] = mergeTrendRowsByEntity([trendRow('Prod', -75, 0, -100)]);
    expect(credit?.percentChange).toBe(-100);
    const [spend] = mergeTrendRowsByEntity([trendRow('Prod', 250, 0, 100)]);
    expect(spend?.percentChange).toBe(100);
  });

  it('measures a merged entity against its merged previous cost', () => {
    // Two account ids sharing a display name: one new, one that existed.
    const [merged] = mergeTrendRowsByEntity([trendRow('Prod', 50, 0, 100), trendRow('Prod', 130, 100, 30)]);
    expect(merged).toMatchObject({ currentCost: 180, previousCost: 100, delta: 80, percentChange: 80 });
  });
});
