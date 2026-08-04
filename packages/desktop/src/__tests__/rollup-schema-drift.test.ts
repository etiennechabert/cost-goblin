import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { buildRollupPartitionQuery, rollupGrainColumns, type DimensionsConfig, type CostScopeConfig, type ProviderName, asDimensionId, asProviderName } from '@costgoblin/core';
import { RollupStore, type RollupShape, type BuildPartitionSql } from '../main/rollup-store.js';
import type { RawRow } from '../main/duckdb-client.js';

// FOCUS 1.2 pins the core column set (all four cost columns always present),
// so the CUR-era mixed-schema machinery — per-period column probing, the
// amortized degradation path — is gone. What still deserves a store-level
// guard is the cold rebuild itself: multiple months building through
// maintainPeriods, each partition's stored cost matching the chosen metric,
// including a month whose parquet carries an EXTRA column a future export
// revision might add (must be ignored, not fatal).

const FOCUS_COLS: readonly [string, string][] = [
  ['ChargePeriodStart', 'TIMESTAMP'],
  ['SubAccountId', 'VARCHAR'],
  ['SubAccountName', 'VARCHAR'],
  ['RegionId', 'VARCHAR'],
  ['ServiceName', 'VARCHAR'],
  ['x_ServiceCode', 'VARCHAR'],
  ['ServiceCategory', 'VARCHAR'],
  ['ResourceId', 'VARCHAR'],
  ['BilledCost', 'DOUBLE'],
  ['EffectiveCost', 'DOUBLE'],
  ['ListCost', 'DOUBLE'],
  ['ContractedCost', 'DOUBLE'],
  ['ChargeCategory', 'VARCHAR'],
  ['PricingCategory', 'VARCHAR'],
  ['CommitmentDiscountStatus', 'VARCHAR'],
  ['x_Operation', 'VARCHAR'],
  ['SkuMeter', 'VARCHAR'],
  ['ConsumedQuantity', 'DOUBLE'],
  ['ChargeDescription', 'VARCHAR'],
  ['Tags', 'MAP(VARCHAR, VARCHAR)'],
];

interface FixtureRow {
  readonly start: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly service: string;
  readonly billed: number;
  readonly effective: number;
  readonly chargeCategory: string;
  readonly commitmentStatus: string;
}

function rowsFor(period: string): readonly FixtureRow[] {
  const d = `${period}-05`;
  // One standard usage row, one commitment-covered row (billed 0), one
  // unused-commitment row (effective only) — the FOCUS shapes whose split
  // between billed and effective the rollup must preserve.
  return [
    { start: `${d} 00:00:00`, accountId: '111', accountName: 'acct-a', service: 'Amazon Elastic Compute Cloud', billed: 10, effective: 10, chargeCategory: 'Usage', commitmentStatus: '' },
    { start: `${d} 01:00:00`, accountId: '111', accountName: 'acct-a', service: 'Amazon Elastic Compute Cloud', billed: 0, effective: 7, chargeCategory: 'Usage', commitmentStatus: 'Used' },
    { start: `${d} 02:00:00`, accountId: '222', accountName: 'acct-b', service: 'Amazon Simple Storage Service', billed: 0, effective: 3, chargeCategory: 'Usage', commitmentStatus: 'Unused' },
  ];
}

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [],
};
const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };
const shape: RollupShape = { signature: 'SIG-DRIFT', grainDimensions: rollupGrainColumns(dimensions) };
const etags = { '2025-10': { f: 'h-old' }, '2026-04': { f: 'h-new' } };
// This suite seeds its raw tree under {dataDir}/aws/raw/... — 'aws' is the
// provider name for both the build SQL and the store's rollup dir.
const providerName = (): ProviderName => asProviderName('aws');

describe('RollupStore cold rebuild over multiple months', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;
  let dataDir: string;
  let runQuery: (sql: string) => Promise<RawRow[]>;

  const buildPerPeriod: BuildPartitionSql = (period, outPath) =>
    buildRollupPartitionQuery(period, 'daily', outPath, { dataDir, dimensions, costScope, providers: [{ name: providerName() }] });

  function sqlValue(col: string, type: string, row: FixtureRow): string {
    switch (col) {
      case 'ChargePeriodStart': return `TIMESTAMP '${row.start}'`;
      case 'SubAccountId': return `'${row.accountId}'`;
      case 'SubAccountName': return `'${row.accountName}'`;
      case 'ServiceName': return `'${row.service}'`;
      case 'BilledCost': return String(row.billed);
      case 'EffectiveCost': return String(row.effective);
      case 'ChargeCategory': return `'${row.chargeCategory}'`;
      case 'CommitmentDiscountStatus': return `'${row.commitmentStatus}'`;
      case 'Tags': return 'MAP {}';
      // Columns the rollup build doesn't read — fill a type-appropriate default.
      default: return type === 'TIMESTAMP' ? `TIMESTAMP '${row.start}'` : type === 'DOUBLE' ? '0' : `''`;
    }
  }

  async function writeMonth(period: string, extraColumn: boolean): Promise<void> {
    const dir = join(dataDir, 'aws', 'raw', `daily-${period}`);
    await mkdir(dir, { recursive: true });
    // A future AWS export revision may add columns we don't reference —
    // the build must ignore them.
    const schema = extraColumn ? [...FOCUS_COLS, ['x_FutureColumn', 'VARCHAR'] as [string, string]] : [...FOCUS_COLS];
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

  it('builds every month, including one with an unreferenced extra column', async () => {
    const store = new RollupStore({ dataDir, providerName, runQuery });
    // Newest-first, exactly like warmupRollup orders toBuild.
    await store.maintainPeriods(['2026-04', '2025-10'], buildPerPeriod, etags, shape);

    expect([...store.getValidPeriods()].sort()).toEqual(['2025-10', '2026-04']);
    await expect(stat(join(dataDir, 'aws', 'rollup', 'daily-2025-10', 'rollup.parquet'))).resolves.toBeDefined();
    await expect(stat(join(dataDir, 'aws', 'rollup', 'daily-2026-04', 'rollup.parquet'))).resolves.toBeDefined();

    // Effective metric sums standard (10) + committed-used (7) + unused (3).
    for (const period of ['2025-10', '2026-04']) {
      const rows = await runQuery(`SELECT SUM(cost) AS c FROM read_parquet('${join(dataDir, 'aws', 'rollup', `daily-${period}`, 'rollup.parquet').replaceAll('\\', '/')}')`);
      expect(Number(rows[0]?.['c'])).toBeCloseTo(20);
    }
  });
});
