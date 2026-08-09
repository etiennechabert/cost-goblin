import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asProviderName } from '../types/branded.js';

const PROVIDER = asProviderName('aws');

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

// FOCUS 1.2 pins the core column set — including all four cost columns — so
// the CUR-era drift (whole cost columns appearing mid-history) is gone. What
// still drifts across export revisions are the OPTIONAL x_ extension columns
// AWS adds over time. These are the FOCUS columns buildSource reads.
const FOCUS_BASE_COLS = `
  ChargePeriodStart TIMESTAMP,
  SubAccountId VARCHAR,
  SubAccountName VARCHAR,
  RegionId VARCHAR,
  ServiceName VARCHAR,
  x_ServiceCode VARCHAR,
  ServiceCategory VARCHAR,
  ChargeDescription VARCHAR,
  ConsumedQuantity DOUBLE,
  ResourceId VARCHAR,
  BilledCost DOUBLE,
  EffectiveCost DOUBLE,
  ListCost DOUBLE,
  ContractedCost DOUBLE,
  ChargeCategory VARCHAR,
  PricingCategory VARCHAR,
  CommitmentDiscountStatus VARCHAR,
  SkuMeter VARCHAR
`;

// The optional extension column the older month is missing — the exact drift
// buildSource's union_by_name exists to absorb (NULL-filled, then COALESCEd
// to '' by the `operation` projection).
const OPTIONAL_EXTENSION_COLS = `,
  x_Operation VARCHAR
`;

async function monthTotals(conn: Conn, source: string): Promise<Record<string, number>> {
  const result = await conn.run(
    `SELECT strftime(usage_date, '%Y-%m') AS m, SUM(cost) AS cost FROM ${source} GROUP BY m`,
  );
  const rows = await result.getRowObjects();
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r['m'])] = Number(r['cost']);
  return out;
}

describe('FOCUS schema drift across months (DuckDB end-to-end)', () => {
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

    // Old month: export revision WITHOUT the optional x_Operation column.
    // Totals — billed 13, effective 11, list 18, contracted 12.
    await conn.run(`CREATE TABLE old_focus (${FOCUS_BASE_COLS})`);
    await conn.run(`INSERT INTO old_focus VALUES
      (TIMESTAMP '2025-10-02', '111', 'acct', 'eu-central-1', 'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'ec2', 1, 'r1', 7.0, 6.0, 10.0, 6.5, 'Usage', 'Standard', '', 'Instance Usage'),
      (TIMESTAMP '2025-10-02', '111', 'acct', 'eu-central-1', 'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'ec2', 1, 'r2', 4.0, 3.0, 5.0, 3.5, 'Usage', 'Committed', 'Used', 'Instance Usage'),
      (TIMESTAMP '2025-10-02', '111', 'acct', 'eu-central-1', 'Amazon Simple Storage Service', 'AmazonS3', 'Storage', 's3', 1, 'r3', 2.0, 2.0, 3.0, 2.0, 'Usage', 'Standard', '', 'Requests')
    `);
    await conn.run(`COPY (SELECT * FROM old_focus) TO '${join(oldDir, 'data.parquet')}' (FORMAT PARQUET)`);

    // New month: revision WITH x_Operation. Includes a Tax row so the list
    // metric's charge-category restriction is exercised over the mixed span.
    // Totals — billed 118, effective 114, list (Usage-only) 23.
    await conn.run(`CREATE TABLE new_focus (${FOCUS_BASE_COLS}${OPTIONAL_EXTENSION_COLS})`);
    await conn.run(`INSERT INTO new_focus VALUES
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'ec2', 1, 'r1', 9.0, 8.0, 12.0, 8.5, 'Usage', 'Standard', '', 'Instance Usage', 'RunInstances'),
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'Amazon Elastic Compute Cloud', 'AmazonEC2', 'Compute', 'ec2', 1, 'r2', 8.0, 5.0, 9.0, 5.5, 'Usage', 'Committed', 'Used', 'Instance Usage', 'RunInstances'),
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'Tax', '', 'Adjustment', 'tax', 0, '', 100.0, 100.0, 0.0, 100.0, 'Tax', '', '', '', ''),
      (TIMESTAMP '2026-04-02', '111', 'acct', 'eu-central-1', 'Amazon Simple Storage Service', 'AmazonS3', 'Storage', 's3', 1, 'r4', 1.0, 1.0, 2.0, 1.0, 'Usage', 'Standard', '', 'Requests', 'PutObject')
    `);
    await conn.run(`COPY (SELECT * FROM new_focus) TO '${join(newDir, 'data.parquet')}' (FORMAT PARQUET)`);
  });

  it('guard: a raw mixed-schema list read without union_by_name throws a Binder Error', async () => {
    await expect(
      conn.run(`SELECT x_Operation FROM read_parquet(['${oldGlob}', '${newGlob}'])`),
    ).rejects.toThrow(/x_Operation/);
  });

  it.each([
    // effective — old month 6 + 3 + 2 = 11; new month 8 + 5 + 100 (Tax) + 1 = 114.
    { metric: 'effective', label: 'explicit periods', providers: [{ name: PROVIDER, periods: ['2025-10', '2026-04'] }], oldTotal: 11, newTotal: 114 },
    { metric: 'effective', label: 'wildcard fallback, no periods', providers: [{ name: PROVIDER }], oldTotal: 11, newTotal: 114 },
    // billed — 7 + 4 + 2 = 13; 9 + 8 + 100 + 1 = 118.
    { metric: 'billed', label: 'explicit periods', providers: [{ name: PROVIDER, periods: ['2025-10', '2026-04'] }], oldTotal: 13, newTotal: 118 },
    // list restricts to Usage charge categories — 10 + 5 + 3 = 18; 12 + 9 + 2 = 23 (Tax row excluded).
    { metric: 'list', label: 'explicit periods', providers: [{ name: PROVIDER, periods: ['2025-10', '2026-04'] }], oldTotal: 18, newTotal: 23 },
  ] as const)('$metric over the mixed span ($label): both export revisions union cleanly', async ({ metric, providers, oldTotal, newTotal }) => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers, costMetric: metric });
    const totals = await monthTotals(conn, source);
    expect(totals['2025-10']).toBe(oldTotal);
    expect(totals['2026-04']).toBe(newTotal);
  });

  it('the missing x_ column is NULL-filled and coalesced, so grouping on it spans both shapes', async () => {
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: PROVIDER, periods: ['2025-10', '2026-04'] }], costMetric: 'effective' });
    const result = await conn.run(
      `SELECT strftime(usage_date, '%Y-%m') AS m, operation FROM ${source} GROUP BY m, operation ORDER BY m, operation`,
    );
    const rows = await result.getRowObjects();
    const byMonth = new Map<string, string[]>();
    for (const r of rows) {
      const m = String(r['m']);
      const ops = byMonth.get(m) ?? [];
      ops.push(String(r['operation']));
      byMonth.set(m, ops);
    }
    // Drifted (old) month: x_Operation absent → NULL-filled → coalesced to ''.
    expect(byMonth.get('2025-10')).toEqual(['']);
    // New month: real values pass through ('' is the Tax row's empty operation).
    expect(byMonth.get('2026-04')).toEqual(['', 'PutObject', 'RunInstances']);
  });
});
