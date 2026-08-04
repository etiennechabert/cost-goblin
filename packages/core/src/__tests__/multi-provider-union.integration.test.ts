import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource, buildCostQuery, resolveField } from '../query/builder.js';
import type { ProviderSourceBranch } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDateString, asDimensionId, asProviderName } from '../types/branded.js';

const PAYER_A = asProviderName('payer-a');
const PAYER_B = asProviderName('payer-b');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('provider'), label: 'Provider', field: 'provider' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
  ],
  tags: [],
};

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function rowsOf(conn: Conn, sql: string): Promise<Record<string, unknown>[]> {
  const result = await conn.run(sql);
  return result.getRowObjects();
}

/** Seed one provider's daily partition with FOCUS 1.2-shaped rows. All four
 *  cost columns are always present in a FOCUS export; per-row `effective`
 *  lets a commitment-covered row price differently from its billed cost —
 *  cost expressions are still evaluated per union branch, so each provider
 *  must be priced from its own export. */
async function seedProvider(
  conn: Conn,
  dataDir: string,
  provider: string,
  period: string,
  rows: readonly { account: string; service: string; billed: number; effective?: number; pricingCategory?: string }[],
): Promise<void> {
  const partDir = join(dataDir, provider, 'raw', `daily-${period}`);
  await mkdir(partDir, { recursive: true });
  const table = `focus_${provider.replaceAll('-', '_')}_${period.replaceAll('-', '_')}`;
  await conn.run(`
    CREATE TABLE ${table} (
      ChargePeriodStart TIMESTAMP,
      SubAccountId VARCHAR,
      SubAccountName VARCHAR,
      RegionId VARCHAR,
      ServiceName VARCHAR,
      x_ServiceCode VARCHAR,
      ServiceCategory VARCHAR,
      ChargeDescription VARCHAR,
      ConsumedQuantity DOUBLE,
      ListCost DOUBLE,
      ResourceId VARCHAR,
      BilledCost DOUBLE,
      EffectiveCost DOUBLE,
      ContractedCost DOUBLE,
      ChargeCategory VARCHAR,
      PricingCategory VARCHAR,
      CommitmentDiscountStatus VARCHAR,
      x_Operation VARCHAR,
      SkuMeter VARCHAR
    )
  `);
  for (const r of rows) {
    const effective = r.effective ?? r.billed;
    const pricingCategory = r.pricingCategory ?? 'Standard';
    const commitmentStatus = pricingCategory === 'Committed' ? 'Used' : '';
    await conn.run(`INSERT INTO ${table} VALUES
      (TIMESTAMP '${period}-15', '${r.account}', 'acct', 'eu-central-1', '${r.service}', '${r.service}', 'Compute', 'row', 1,
       ${String(r.billed)}, 'res', ${String(r.billed)}, ${String(effective)}, ${String(r.billed)},
       'Usage', '${pricingCategory}', '${commitmentStatus}', 'Op', 'SKU')
    `);
  }
  await conn.run(`COPY (SELECT * FROM ${table}) TO '${join(partDir, 'data.parquet')}' (FORMAT PARQUET)`);
}

describe('multi-provider union (DuckDB end-to-end)', () => {
  let conn: Conn;
  let dataDir: string;

  beforeAll(async () => {
    const db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-multi-'));

    // payer-a: two months. The EC2 row is commitment-covered usage: on the
    // effective metric its cost comes from EffectiveCost (80), not
    // BilledCost (100).
    await seedProvider(conn, dataDir, 'payer-a', '2026-01', [
      { account: '111', service: 'AmazonEC2', billed: 100, effective: 80, pricingCategory: 'Committed' },
      { account: '222', service: 'AmazonRDS', billed: 50 },
    ]);
    await seedProvider(conn, dataDir, 'payer-a', '2026-02', [
      { account: '111', service: 'AmazonEC2', billed: 10 },
    ]);
    // payer-b: one month, and it sees account 111 too (an account visible
    // from two payers — the provider dim disambiguates).
    await seedProvider(conn, dataDir, 'payer-b', '2026-01', [
      { account: '111', service: 'AmazonEC2', billed: 7 },
      { account: '333', service: 'AmazonS3', billed: 3 },
    ]);
  });

  function branches(): ProviderSourceBranch[] {
    return [
      { name: PAYER_A, periods: ['2026-01', '2026-02'] },
      { name: PAYER_B, periods: ['2026-01'] },
    ];
  }

  it('unions every provider and injects the provider column', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'billed' });
    const rows = await rowsOf(conn, `SELECT provider, SUM(cost) AS cost FROM ${source} GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'payer-a', cost: 160 },
      { provider: 'payer-b', cost: 10 },
    ]);
  });

  it('per-provider month lists keep DuckDB clear of zero-match globs', async () => {
    // payer-b has no 2026-02 on disk — its branch simply lists fewer globs.
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'billed' });
    const rows = await rowsOf(conn, `SELECT SUM(cost) AS cost FROM ${source} WHERE usage_date BETWEEN '2026-02-01' AND '2026-02-28'`);
    expect(rows).toEqual([{ cost: 10 }]);
  });

  it('the provider dimension filters like any other dimension', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'billed' });
    const { fieldExpr } = resolveField(asDimensionId('provider'), dimensions);
    const rows = await rowsOf(conn, `SELECT SUM(cost) AS cost FROM ${source} WHERE ${fieldExpr} = 'payer-b'`);
    expect(rows).toEqual([{ cost: 10 }]);
  });

  it('disambiguates an account visible from two payers', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'billed' });
    const rows = await rowsOf(conn, `SELECT provider, SUM(cost) AS cost FROM ${source} WHERE account_id = '111' GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'payer-a', cost: 110 },
      { provider: 'payer-b', cost: 7 },
    ]);
  });

  it("evaluates the cost expression per branch — 'effective' prices each provider from its own columns", async () => {
    // payer-a's EC2 row is commitment-covered (EffectiveCost 80 ≠ BilledCost
    // 100); payer-b's rows have billed == effective. A union that priced one
    // branch from the other's rows would misreport one of them.
    const source = buildSource({
      dataDir, tier: 'daily', dimensions,
      providers: [
        { name: PAYER_A, periods: ['2026-01'] },
        { name: PAYER_B, periods: ['2026-01'] },
      ],
      costMetric: 'effective',
    });
    const rows = await rowsOf(conn, `SELECT provider, SUM(cost) AS cost FROM ${source} GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'payer-a', cost: 130 }, // 80 effective + 50
      { provider: 'payer-b', cost: 10 },  // billed == effective
    ]);
  });

  it('buildCostQuery drops a configured-but-empty provider instead of failing the union', async () => {
    const { sql, params } = buildCostQuery(
      { groupBy: asDimensionId('service'), dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') }, filters: {}, granularity: 'daily' },
      {
        dataDir, dimensions,
        providers: [
          { name: PAYER_A, availablePeriods: ['2026-01', '2026-02'] },
          { name: asProviderName('payer-never-synced'), availablePeriods: [] },
          { name: PAYER_B, availablePeriods: ['2026-01'] },
        ],
      },
    );
    expect(sql).not.toContain('payer-never-synced');
    const prepared = await conn.prepare(sql);
    let i = 1;
    for (const p of params) {
      if (typeof p === 'number') prepared.bindDouble(i, p);
      else prepared.bindVarchar(i, String(p));
      i++;
    }
    const result = await prepared.run();
    const rows = await result.getRowObjects();
    const total = rows.reduce((sum: number, r) => {
      const entity = r['entity'];
      const cost = r['total_cost'];
      return entity !== null && typeof cost === 'number' ? sum + cost : sum;
    }, 0);
    // 2026-01 across both payers on the default 'effective' metric:
    // payer-a 80 (committed EC2) + 50, payer-b 7 + 3.
    expect(total).toBe(140);
  });
});
