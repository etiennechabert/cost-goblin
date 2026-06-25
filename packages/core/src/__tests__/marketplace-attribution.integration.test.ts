import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { MarketplaceAttributionConfig } from '../types/cost-scope.js';
import { DEFAULT_MARKETPLACE_ATTRIBUTION } from '../config/cost-scope-seed.js';
import { asDimensionId } from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [],
};

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function serviceTotals(
  conn: Conn,
  dataDir: string,
  costMetric: 'unblended' | 'list',
  marketplaceAttribution: MarketplaceAttributionConfig | undefined,
): Promise<Record<string, number>> {
  const source = buildSource({ dataDir, tier: 'daily', dimensions, costMetric, marketplaceAttribution });
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
      CREATE TABLE cur (
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
      )
    `);
    // Row 1: third-party Marketplace Bedrock (Claude) — empty servicecode, real
    //         cost only in unblended, $0 on-demand.
    // Row 2: first-party Bedrock (Titan) — already tagged, both costs populated.
    // Row 3: ordinary EC2 usage — control row, must never be rewritten.
    await conn.run(`INSERT INTO cur VALUES
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', '', '', 'Claude', 'r1', 1, 10.0, 0.0, 'Usage', 'InvokeModelInference', 'EUC1-InputTokenCount'),
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', 'AmazonBedrock', '', 'Titan', 'r2', 1, 5.0, 5.0, 'Usage', 'InvokeModelInference', 'EUC1-TitanTokens'),
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', '', 'EC2', 'r3', 1, 20.0, 25.0, 'Usage', 'RunInstances', 'EUC1-BoxUsage')
    `);
    await conn.run(`COPY (SELECT * FROM cur) TO '${join(partDir, 'data.parquet')}' (FORMAT PARQUET)`);
  });

  it('unblended: re-attributes the Marketplace row to AmazonBedrock, keeps its dollars', async () => {
    const totals = await serviceTotals(conn, dataDir, 'unblended', DEFAULT_MARKETPLACE_ATTRIBUTION);
    // Claude ($10, re-attributed) + Titan ($5) collapse into AmazonBedrock.
    expect(totals['AmazonBedrock']).toBe(15);
    expect(totals['AmazonEC2']).toBe(20);
    expect(totals['']).toBeUndefined(); // no blank-service bucket
  });

  it('unblended + disabled: dollars survive but land under a blank service', async () => {
    const totals = await serviceTotals(conn, dataDir, 'unblended', { enabled: false, rules: DEFAULT_MARKETPLACE_ATTRIBUTION.rules });
    expect(totals['']).toBe(10); // Claude stranded under blank service
    expect(totals['AmazonBedrock']).toBe(5); // only Titan
  });

  it('list: the bug — disabled drops the Marketplace dollars to $0', async () => {
    const totals = await serviceTotals(conn, dataDir, 'list', { enabled: false, rules: [] });
    expect(totals['']).toBe(0); // Claude invisible on the list metric
    expect(totals['AmazonBedrock']).toBe(5); // Titan on-demand
    expect(totals['AmazonEC2']).toBe(25);
  });

  it('list + enabled: substitutes unblended for the $0 list price and re-attributes', async () => {
    const totals = await serviceTotals(conn, dataDir, 'list', DEFAULT_MARKETPLACE_ATTRIBUTION);
    // Claude now counts at unblended $10, folded into AmazonBedrock with Titan's $5.
    expect(totals['AmazonBedrock']).toBe(15);
    expect(totals['AmazonEC2']).toBe(25); // unaffected: real on-demand price kept
    expect(totals['']).toBeUndefined();
  });
});
