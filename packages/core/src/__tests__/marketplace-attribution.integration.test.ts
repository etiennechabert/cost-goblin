import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostMetric, MarketplaceAttributionConfig } from '../types/cost-scope.js';
import { DEFAULT_MARKETPLACE_ATTRIBUTION } from '../config/cost-scope-seed.js';
import { asDimensionId, asProviderName } from '../types/branded.js';

const PROVIDER = asProviderName('aws');

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function serviceTotals(
  conn: Conn,
  dataDir: string,
  costMetric: CostMetric,
  marketplaceAttribution: MarketplaceAttributionConfig | undefined,
): Promise<Record<string, number>> {
  const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: PROVIDER }], costMetric, marketplaceAttribution });
  const result = await conn.run(`SELECT service, SUM(cost) AS cost FROM ${source} GROUP BY service`);
  const rows = await result.getRowObjects();
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r['service'])] = Number(r['cost']);
  return out;
}

describe('marketplace attribution (DuckDB end-to-end)', () => {
  let conn: Conn;
  let dataDir: string;

  beforeAll(async () => {
    const db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-mkt-'));
    const partDir = join(dataDir, 'aws', 'raw', 'daily-2026-05');
    await mkdir(partDir, { recursive: true });

    await conn.run(`
      CREATE TABLE focus_rows (
        ChargePeriodStart TIMESTAMP,
        SubAccountId VARCHAR,
        SubAccountName VARCHAR,
        RegionId VARCHAR,
        ServiceName VARCHAR,
        ServiceCategory VARCHAR,
        ChargeDescription VARCHAR,
        ChargeCategory VARCHAR,
        PricingCategory VARCHAR,
        CommitmentDiscountStatus VARCHAR,
        ConsumedQuantity DOUBLE,
        ResourceId VARCHAR,
        BilledCost DOUBLE,
        EffectiveCost DOUBLE,
        ListCost DOUBLE,
        ContractedCost DOUBLE,
        SkuMeter VARCHAR,
        x_Operation VARCHAR,
        x_ServiceCode VARCHAR
      )
    `);
    // Row 1: third-party Marketplace Bedrock (Claude) — empty x_ServiceCode
    //         and ServiceName, real cost only in billed/effective, $0 list.
    // Row 2: first-party Bedrock (Titan) — already attributed, all costs set.
    // Row 3: ordinary EC2 usage — control row, must never be rewritten.
    await conn.run(`INSERT INTO focus_rows VALUES
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', '', 'AI and Machine Learning', 'Claude', 'Usage', 'Standard', NULL, 1, 'r1', 10.0, 10.0, 0.0, 10.0, '', 'InvokeModelInference', ''),
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', 'Amazon Bedrock', 'AI and Machine Learning', 'Titan', 'Usage', 'Standard', NULL, 1, 'r2', 5.0, 5.0, 5.0, 5.0, 'EUC1-TitanTokens', 'InvokeModelInference', 'AmazonBedrock'),
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', 'Amazon Elastic Compute Cloud', 'Compute', 'EC2', 'Usage', 'Standard', NULL, 1, 'r3', 20.0, 20.0, 25.0, 20.0, 'EUC1-BoxUsage', 'RunInstances', 'AmazonEC2')
    `);
    await conn.run(`COPY (SELECT * FROM focus_rows) TO '${join(partDir, 'data.parquet')}' (FORMAT PARQUET)`);
  });

  it('billed: re-attributes the Marketplace row to Amazon Bedrock, keeps its dollars', async () => {
    const totals = await serviceTotals(conn, dataDir, 'billed', DEFAULT_MARKETPLACE_ATTRIBUTION);
    // Claude ($10, re-attributed) + Titan ($5) collapse into Amazon Bedrock.
    expect(totals['Amazon Bedrock']).toBe(15);
    expect(totals['Amazon Elastic Compute Cloud']).toBe(20);
    expect(totals['']).toBeUndefined(); // no blank-service bucket
  });

  it('billed + disabled: dollars survive but land under a blank service', async () => {
    const totals = await serviceTotals(conn, dataDir, 'billed', { enabled: false, rules: DEFAULT_MARKETPLACE_ATTRIBUTION.rules });
    expect(totals['']).toBe(10); // Claude stranded under blank service
    expect(totals['Amazon Bedrock']).toBe(5); // only Titan
  });

  it('list: the bug — disabled drops the Marketplace dollars to $0', async () => {
    const totals = await serviceTotals(conn, dataDir, 'list', { enabled: false, rules: [] });
    expect(totals['']).toBe(0); // Claude invisible on the list metric
    expect(totals['Amazon Bedrock']).toBe(5); // Titan list price
    expect(totals['Amazon Elastic Compute Cloud']).toBe(25);
  });

  it('list + enabled: substitutes billed cost for the $0 list price and re-attributes', async () => {
    const totals = await serviceTotals(conn, dataDir, 'list', DEFAULT_MARKETPLACE_ATTRIBUTION);
    // Claude now counts at billed $10, folded into Amazon Bedrock with Titan's $5.
    expect(totals['Amazon Bedrock']).toBe(15);
    expect(totals['Amazon Elastic Compute Cloud']).toBe(25); // unaffected: real list price kept
    expect(totals['']).toBeUndefined();
  });
});
