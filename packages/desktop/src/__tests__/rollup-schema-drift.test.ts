import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { buildRollupPartitionQuery, rollupGrainColumns, type DimensionsConfig, type CostScopeConfig, asDimensionId } from '@costgoblin/core';
import { RollupStore, type RollupShape, type BuildPartitionSql } from '../main/rollup-store.js';
import type { RawRow } from '../main/duckdb-client.js';

// Months drift in which optional cost columns they carry: a CUR ships
// reservation_effective_cost / the SP effective-cost family only from the
// billing period the user enabled resource IDs. The amortized metric
// references those columns, so a cold rebuild that builds an OLDER month (which
// lacks them) with the LATEST month's column set throws a DuckDB Binder Error
// and that partition never builds. This guards the per-period probe fix.

// Columns every CUR carries. `type` is appended per-column below.
const BASE_COLS: readonly [string, string][] = [
  ['line_item_usage_start_date', 'TIMESTAMP'],
  ['line_item_usage_account_id', 'VARCHAR'],
  ['line_item_usage_account_name', 'VARCHAR'],
  ['product_region_code', 'VARCHAR'],
  ['product_servicecode', 'VARCHAR'],
  ['product_product_family', 'VARCHAR'],
  ['line_item_resource_id', 'VARCHAR'],
  ['line_item_usage_amount', 'DOUBLE'],
  ['line_item_unblended_cost', 'DOUBLE'],
  ['line_item_net_unblended_cost', 'DOUBLE'],
  ['pricing_public_on_demand_cost', 'DOUBLE'],
  ['line_item_line_item_type', 'VARCHAR'],
  ['line_item_operation', 'VARCHAR'],
  ['line_item_usage_type', 'VARCHAR'],
];
// Optional RI/SP effective-cost columns — present only once the user enables
// resource IDs. The amortized metric references these; an older month lacks
// them entirely (matches real data — 18-col months still keep net_unblended).
const OPTIONAL_COLS: readonly [string, string][] = [
  ['reservation_effective_cost', 'DOUBLE'],
  ['reservation_net_effective_cost', 'DOUBLE'],
  ['savings_plan_savings_plan_effective_cost', 'DOUBLE'],
  ['savings_plan_net_savings_plan_effective_cost', 'DOUBLE'],
];

interface FixtureRow {
  readonly line_item_usage_start_date: string;
  readonly line_item_usage_account_id: string;
  readonly line_item_usage_account_name: string;
  readonly product_servicecode: string;
  readonly product_product_family: string;
  readonly line_item_resource_id: string;
  readonly line_item_unblended_cost: number;
  readonly reservation_effective_cost: number;
  readonly savings_plan_savings_plan_effective_cost: number;
  readonly line_item_line_item_type: string;
  readonly line_item_operation: string;
}

function rowsFor(period: string): readonly FixtureRow[] {
  const d = `${period}-05`;
  // One RI-covered, one SP-covered, one plain Usage row.
  return [
    { line_item_usage_start_date: `${d} 00:00:00`, line_item_usage_account_id: '111', line_item_usage_account_name: 'acct-a', product_servicecode: 'AmazonEC2', product_product_family: 'Compute', line_item_resource_id: 'i-1', line_item_unblended_cost: 10, reservation_effective_cost: 7, savings_plan_savings_plan_effective_cost: 0, line_item_line_item_type: 'DiscountedUsage', line_item_operation: 'RunInstances' },
    { line_item_usage_start_date: `${d} 01:00:00`, line_item_usage_account_id: '111', line_item_usage_account_name: 'acct-a', product_servicecode: 'AmazonEC2', product_product_family: 'Compute', line_item_resource_id: 'i-2', line_item_unblended_cost: 20, reservation_effective_cost: 0, savings_plan_savings_plan_effective_cost: 3, line_item_line_item_type: 'SavingsPlanCoveredUsage', line_item_operation: 'RunInstances' },
    { line_item_usage_start_date: `${d} 02:00:00`, line_item_usage_account_id: '222', line_item_usage_account_name: 'acct-b', product_servicecode: 'AmazonS3', product_product_family: 'Storage', line_item_resource_id: 's-1', line_item_unblended_cost: 5, reservation_effective_cost: 0, savings_plan_savings_plan_effective_cost: 0, line_item_line_item_type: 'Usage', line_item_operation: 'GetObject' },
  ];
}

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [],
};
// Amortized is the metric that references the optional RI/SP columns.
const costScope: CostScopeConfig = { costMetric: 'amortized', costPerspective: 'gross', rules: [] };
const shape: RollupShape = { signature: 'SIG-DRIFT', grainDimensions: rollupGrainColumns(dimensions), availableColumns: ['account_id', 'account_name', 'service'] };
const etags = { '2025-10': { f: 'h-old' }, '2026-04': { f: 'h-new' } };

describe('RollupStore cold rebuild over mixed-schema months', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let dataDir: string;
  let runQuery: (sql: string) => Promise<RawRow[]>;

  // Probe ONE month's columns (mirrors context.ts getColumnsForPeriod).
  async function probe(period: string): Promise<ReadonlySet<string>> {
    const glob = `${dataDir}/aws/raw/daily-${period}/*.parquet`;
    const rows = await runQuery(`DESCRIBE SELECT * FROM read_parquet('${glob}') LIMIT 0`);
    const cols = new Set<string>();
    for (const r of rows) { const n = r['column_name']; if (typeof n === 'string') cols.add(n); }
    return cols;
  }

  // The fixed wiring: each period's build SQL uses THAT period's columns.
  const buildPerPeriod: BuildPartitionSql = async (period, outPath) =>
    buildRollupPartitionQuery(period, 'daily', outPath, { dataDir, dimensions, costScope, availableColumns: await probe(period) });

  // The OLD (buggy) wiring: every period uses the latest month's columns.
  const buildLatestForAll: BuildPartitionSql = async (period, outPath) =>
    buildRollupPartitionQuery(period, 'daily', outPath, { dataDir, dimensions, costScope, availableColumns: await probe('2026-04') });

  function sqlValue(col: string, type: string, row: FixtureRow): string {
    switch (col) {
      case 'line_item_usage_start_date': return `TIMESTAMP '${row.line_item_usage_start_date}'`;
      case 'line_item_usage_account_id': return `'${row.line_item_usage_account_id}'`;
      case 'line_item_usage_account_name': return `'${row.line_item_usage_account_name}'`;
      case 'product_servicecode': return `'${row.product_servicecode}'`;
      case 'product_product_family': return `'${row.product_product_family}'`;
      case 'line_item_resource_id': return `'${row.line_item_resource_id}'`;
      case 'line_item_unblended_cost': return String(row.line_item_unblended_cost);
      case 'line_item_line_item_type': return `'${row.line_item_line_item_type}'`;
      case 'line_item_operation': return `'${row.line_item_operation}'`;
      case 'reservation_effective_cost': return String(row.reservation_effective_cost);
      case 'savings_plan_savings_plan_effective_cost': return String(row.savings_plan_savings_plan_effective_cost);
      // Columns the rollup build doesn't read — fill a type-appropriate default.
      default: return type === 'TIMESTAMP' ? `TIMESTAMP '${row.line_item_usage_start_date}'` : type === 'VARCHAR' ? `''` : '0';
    }
  }

  async function writeMonth(period: string, full: boolean): Promise<void> {
    const dir = join(dataDir, 'aws', 'raw', `daily-${period}`);
    await mkdir(dir, { recursive: true });
    const schema = full ? [...BASE_COLS, ...OPTIONAL_COLS] : [...BASE_COLS];
    await conn.run(`CREATE OR REPLACE TABLE m (${schema.map(([n, t]) => `${n} ${t}`).join(', ')})`);
    const colNames = schema.map(([n]) => n).join(', ');
    const values = rowsFor(period)
      .map(row => `(${schema.map(([n, t]) => sqlValue(n, t, row)).join(', ')})`)
      .join(', ');
    await conn.run(`INSERT INTO m (${colNames}) VALUES ${values}`);
    await conn.run(`COPY m TO '${join(dir, 'data.parquet')}' (FORMAT PARQUET)`);
  }

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-rollup-drift-'));
    runQuery = async (sql: string): Promise<RawRow[]> => {
      const result = await conn.run(sql);
      const cols = result.columnCount;
      const names: string[] = [];
      for (let i = 0; i < cols; i++) names.push(result.columnName(i));
      const rows: RawRow[] = [];
      let chunk = await result.fetchChunk();
      while (chunk !== null && chunk.rowCount > 0) {
        for (let r = 0; r < chunk.rowCount; r++) {
          const row: Record<string, unknown> = {};
          for (let c = 0; c < cols; c++) { const n = names[c]; if (n !== undefined) row[n] = chunk.getColumnVector(c).getItem(r); }
          rows.push(row);
        }
        chunk = await result.fetchChunk();
      }
      return rows;
    };
    await writeMonth('2025-10', false);
    await writeMonth('2026-04', true);
  });
  afterAll(async () => { await rm(dataDir, { recursive: true, force: true }); });

  it('builds every month, including the older drifted-schema one (no Binder Error)', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    // Newest-first, exactly like warmupRollup orders toBuild.
    await store.maintainPeriods(['2026-04', '2025-10'], buildPerPeriod, etags, shape);

    expect([...store.getValidPeriods()].sort()).toEqual(['2025-10', '2026-04']);
    await expect(stat(join(dataDir, 'aws', 'rollup', 'daily-2025-10', 'rollup.parquet'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'aws', 'rollup', 'daily-2026-04', 'rollup.parquet'))).resolves.toBeDefined();

    // The drifted month degrades amortized → unblended (it has nothing to
    // amortize against), so its cost is the sum of unblended: 10 + 20 + 5 = 35.
    const old = await runQuery(`SELECT SUM(cost) AS c FROM read_parquet('${join(dataDir, 'aws', 'rollup', 'daily-2025-10', 'rollup.parquet').replaceAll('\\', '/')}')`);
    expect(Number(old[0]?.['c'])).toBeCloseTo(35);

    // The full month uses true amortized: RI effective (7) + SP effective (3) +
    // Usage unblended (5) = 15.
    const recent = await runQuery(`SELECT SUM(cost) AS c FROM read_parquet('${join(dataDir, 'aws', 'rollup', 'daily-2026-04', 'rollup.parquet').replaceAll('\\', '/')}')`);
    expect(Number(recent[0]?.['c'])).toBeCloseTo(15);
  });

  it('regression guard: the old latest-month-for-all wiring fails to build the drifted month', async () => {
    const store = new RollupStore({ dataDir, runQuery });
    await store.maintainPeriods(['2026-04', '2025-10'], buildLatestForAll, etags, shape);
    // 2026-04 builds; 2025-10's COPY throws a Binder Error and is skipped.
    expect([...store.getValidPeriods()]).toEqual(['2026-04']);
  });
});
