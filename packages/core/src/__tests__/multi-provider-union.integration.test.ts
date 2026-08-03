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

/** Seed one provider's daily partition. `withReservationColumn` mimics a
 *  payer whose CUR export carries the optional amortized-cost column —
 *  providers can genuinely differ here, which is why cost expressions are
 *  evaluated per union branch. */
async function seedProvider(
  conn: Conn,
  dataDir: string,
  provider: string,
  period: string,
  rows: readonly { account: string; service: string; cost: number; effectiveCost?: number; lineItemType?: string }[],
  withReservationColumn: boolean,
): Promise<void> {
  const partDir = join(dataDir, provider, 'raw', `daily-${period}`);
  await mkdir(partDir, { recursive: true });
  const table = `cur_${provider.replaceAll('-', '_')}_${period.replaceAll('-', '_')}`;
  const extraCol = withReservationColumn ? ',\n      reservation_effective_cost DOUBLE' : '';
  await conn.run(`
    CREATE TABLE ${table} (
      line_item_usage_start_date TIMESTAMP,
      line_item_usage_account_id VARCHAR,
      line_item_usage_account_name VARCHAR,
      product_region_code VARCHAR,
      product_servicecode VARCHAR,
      product_product_family VARCHAR,
      line_item_line_item_description VARCHAR,
      line_item_resource_id VARCHAR,
      line_item_usage_amount DOUBLE,
      line_item_unblended_cost DOUBLE,
      pricing_public_on_demand_cost DOUBLE,
      line_item_line_item_type VARCHAR,
      line_item_operation VARCHAR,
      line_item_usage_type VARCHAR${extraCol}
    )
  `);
  for (const r of rows) {
    const effective = withReservationColumn ? `, ${String(r.effectiveCost ?? r.cost)}` : '';
    await conn.run(`INSERT INTO ${table} VALUES
      (TIMESTAMP '${period}-15', '${r.account}', 'acct', 'eu-central-1', '${r.service}', '', 'row', 'res', 1, ${String(r.cost)}, ${String(r.cost)}, '${r.lineItemType ?? 'Usage'}', 'Op', 'UT'${effective})
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

    // payer-a: two months, CUR carries reservation_effective_cost.
    // The EC2 row is reserved-instance usage: on the amortized metric its
    // cost comes from reservation_effective_cost (80), not unblended (100).
    await seedProvider(conn, dataDir, 'payer-a', '2026-01', [
      { account: '111', service: 'AmazonEC2', cost: 100, effectiveCost: 80, lineItemType: 'DiscountedUsage' },
      { account: '222', service: 'AmazonRDS', cost: 50, effectiveCost: 50 },
    ], true);
    await seedProvider(conn, dataDir, 'payer-a', '2026-02', [
      { account: '111', service: 'AmazonEC2', cost: 10, effectiveCost: 10 },
    ], true);
    // payer-b: one month, NO reservation column, and it sees account 111 too
    // (an account visible from two payers — the provider dim disambiguates).
    await seedProvider(conn, dataDir, 'payer-b', '2026-01', [
      { account: '111', service: 'AmazonEC2', cost: 7 },
      { account: '333', service: 'AmazonS3', cost: 3 },
    ], false);
  });

  function branches(): ProviderSourceBranch[] {
    return [
      { name: PAYER_A, periods: ['2026-01', '2026-02'] },
      { name: PAYER_B, periods: ['2026-01'] },
    ];
  }

  it('unions every provider and injects the provider column', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'unblended' });
    const rows = await rowsOf(conn, `SELECT provider, SUM(cost) AS cost FROM ${source} GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'payer-a', cost: 160 },
      { provider: 'payer-b', cost: 10 },
    ]);
  });

  it('per-provider month lists keep DuckDB clear of zero-match globs', async () => {
    // payer-b has no 2026-02 on disk — its branch simply lists fewer globs.
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'unblended' });
    const rows = await rowsOf(conn, `SELECT SUM(cost) AS cost FROM ${source} WHERE usage_date BETWEEN '2026-02-01' AND '2026-02-28'`);
    expect(rows).toEqual([{ cost: 10 }]);
  });

  it('the provider dimension filters like any other dimension', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'unblended' });
    const { fieldExpr } = resolveField(asDimensionId('provider'), dimensions);
    const rows = await rowsOf(conn, `SELECT SUM(cost) AS cost FROM ${source} WHERE ${fieldExpr} = 'payer-b'`);
    expect(rows).toEqual([{ cost: 10 }]);
  });

  it('disambiguates an account visible from two payers', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: branches(), costMetric: 'unblended' });
    const rows = await rowsOf(conn, `SELECT provider, SUM(cost) AS cost FROM ${source} WHERE account_id = '111' GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'payer-a', cost: 110 },
      { provider: 'payer-b', cost: 7 },
    ]);
  });

  it('evaluates the cost expression per branch — amortized uses each provider\'s own columns', async () => {
    // payer-a has reservation_effective_cost (80 ≠ 100 on one row); payer-b's
    // export lacks the column entirely — a shared expression would binder-error
    // or silently misprice one of them. Each branch gets its own PROBED column
    // set (undefined would mean "don't gate", which is not how production
    // calls this — getQueryProviders always probes).
    const source = buildSource({
      dataDir, tier: 'daily', dimensions,
      providers: [
        { name: PAYER_A, periods: ['2026-01'], availableColumns: new Set(['reservation_effective_cost']) },
        { name: PAYER_B, periods: ['2026-01'], availableColumns: new Set(['line_item_unblended_cost']) },
      ],
      costMetric: 'amortized',
    });
    const rows = await rowsOf(conn, `SELECT provider, SUM(cost) AS cost FROM ${source} GROUP BY provider ORDER BY provider`);
    expect(rows).toEqual([
      { provider: 'payer-a', cost: 130 }, // 80 effective + 50
      { provider: 'payer-b', cost: 10 },  // unblended fallback
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
    expect(total).toBe(160); // 2026-01 across both payers
  });
});
