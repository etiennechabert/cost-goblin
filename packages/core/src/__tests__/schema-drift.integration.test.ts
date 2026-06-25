import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId } from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

// Columns common to both CUR exports. Mirrors the real subset buildSource reads.
const BASE_COLS = `
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
  line_item_usage_type VARCHAR
`;

// The four effective-cost columns AWS only ships once resource IDs are enabled —
// the exact drift observed in real data (18-col older months → 22-col newer).
const EFFECTIVE_COST_COLS = `,
  reservation_effective_cost DOUBLE,
  reservation_net_effective_cost DOUBLE,
  savings_plan_savings_plan_effective_cost DOUBLE,
  savings_plan_net_savings_plan_effective_cost DOUBLE
`;

// Latest-month schema (with effective-cost columns) is what getAvailableColumns
// probes, so amortizedExpr references reservation_effective_cost /
// savings_plan_savings_plan_effective_cost.
const availableColumns = new Set<string>([
  'line_item_unblended_cost',
  'pricing_public_on_demand_cost',
  'reservation_effective_cost',
  'savings_plan_savings_plan_effective_cost',
]);

async function monthTotals(conn: Conn, source: string): Promise<Record<string, number>> {
  const result = await conn.run(
    `SELECT strftime(usage_date, '%Y-%m') AS m, SUM(cost) AS cost FROM ${source} GROUP BY m`,
  );
  const rows = await result.getRowObjects();
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r['m'])] = Number(r['cost']);
  return out;
}

describe('CUR schema drift across months (DuckDB end-to-end)', () => {
  let conn: Conn;
  let dataDir: string;
  let oldGlob: string;
  let newGlob: string;

  beforeAll(async () => {
    const db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-drift-'));

    const oldDir = join(dataDir, 'aws', 'raw', 'daily-2025-10');
    const newDir = join(dataDir, 'aws', 'raw', 'daily-2026-04');
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    oldGlob = `${oldDir}/*.parquet`;
    newGlob = `${newDir}/*.parquet`;

    // Old month: no effective-cost columns. amortized degrades to unblended.
    await conn.run(`CREATE TABLE old_cur (${BASE_COLS})`);
    await conn.run(`INSERT INTO old_cur VALUES
      (TIMESTAMP '2025-10-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', 'Compute', 'ec2', 'r1', 1, 7.0, 7.0, 'DiscountedUsage', 'RunInstances', 'BoxUsage'),
      (TIMESTAMP '2025-10-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', 'Compute', 'ec2', 'r2', 1, 4.0, 4.0, 'SavingsPlanCoveredUsage', 'RunInstances', 'BoxUsage'),
      (TIMESTAMP '2025-10-02', '111', 'acct', 'eu-central-1', 'AmazonS3', 'Storage', 's3', 'r3', 1, 2.0, 2.0, 'Usage', 'PutObject', 'Requests')
    `);
    await conn.run(`COPY (SELECT * FROM old_cur) TO '${join(oldDir, 'data.parquet')}' (FORMAT PARQUET)`);

    // New month: effective-cost columns present. amortized uses the true value.
    await conn.run(`CREATE TABLE new_cur (${BASE_COLS}${EFFECTIVE_COST_COLS})`);
    await conn.run(`INSERT INTO new_cur VALUES
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', 'Compute', 'ec2', 'r1', 1, 9.0, 9.0, 'DiscountedUsage', 'RunInstances', 'BoxUsage', 3.0, 3.0, 0.0, 0.0),
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', 'Compute', 'ec2', 'r2', 1, 8.0, 8.0, 'SavingsPlanCoveredUsage', 'RunInstances', 'BoxUsage', 0.0, 0.0, 5.0, 5.0),
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', 'Compute', 'ec2', 'r3', 1, 100.0, 0.0, 'RIFee', 'RunInstances', 'BoxUsage', 0.0, 0.0, 0.0, 0.0),
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'AmazonS3', 'Storage', 's3', 'r4', 1, 1.0, 1.0, 'Usage', 'PutObject', 'Requests', 0.0, 0.0, 0.0, 0.0)
    `);
    await conn.run(`COPY (SELECT * FROM new_cur) TO '${join(newDir, 'data.parquet')}' (FORMAT PARQUET)`);
  });

  it('guard: a raw mixed-schema list read without union_by_name throws a Binder Error', async () => {
    await expect(
      conn.run(`SELECT SUM(reservation_effective_cost) FROM read_parquet(['${oldGlob}', '${newGlob}'])`),
    ).rejects.toThrow(/reservation_effective_cost/);
  });

  it('amortized over the mixed span (list form): old rows degrade to unblended, new rows use effective cost', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, periods: ['2025-10', '2026-04'], costMetric: 'amortized', availableColumns });
    const totals = await monthTotals(conn, source);
    // Old month (no effective-cost cols → degraded to unblended): 7 + 4 + 2 = 13.
    expect(totals['2025-10']).toBe(13);
    // New month: DiscountedUsage→3, SP-covered→5, RIFee→0, Usage→1 = 9.
    expect(totals['2026-04']).toBe(9);
  });

  it('amortized over the mixed span (wildcard fallback, no periods): same correct numbers', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, costMetric: 'amortized', availableColumns });
    const totals = await monthTotals(conn, source);
    expect(totals['2025-10']).toBe(13);
    expect(totals['2026-04']).toBe(9);
  });

  it('unblended over the mixed span is unaffected by the unification', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, periods: ['2025-10', '2026-04'], costMetric: 'unblended', availableColumns });
    const totals = await monthTotals(conn, source);
    expect(totals['2025-10']).toBe(13); // 7 + 4 + 2
    expect(totals['2026-04']).toBe(118); // 9 + 8 + 100 + 1
  });
});
