import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDailyCostsQuery, buildMaterializeBaseQuery, buildRollupPartitionQuery } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { asDimensionId, asDateString } from '../types/branded.js';

/**
 * Regression for issue #451: exclusion rules on tag dimensions emitted plain
 * `NOT IN` / `NOT (...)` clauses. Tag expressions are NULL for untagged rows,
 * and in SQL `NULL NOT IN (...)` is NULL — which WHERE treats as false — so a
 * rule like "exclude team IN (sandbox)" silently removed EVERY untagged row
 * from all totals, the materialized base, and persisted rollup partitions.
 */

const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }],
};

const dateRange = { start: asDateString('2026-05-01'), end: asDateString('2026-05-31') };

function scopeWith(conditions: ExclusionRule['conditions']): CostScopeConfig {
  return {
    costMetric: 'unblended',
    rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions }],
  };
}

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

/** Test-only: inline string params in place of prepared-statement placeholders. */
function substituteParams(sql: string, params: readonly unknown[]): string {
  let result = sql;
  for (let i = params.length; i >= 1; i--) {
    const param = params[i - 1];
    const value = typeof param === 'string' ? `'${param}'` : String(param);
    result = result.replaceAll('$' + String(i), value);
  }
  return result;
}

async function sumColumn(conn: Conn, sql: string): Promise<number> {
  const result = await conn.run(sql);
  const rows = await result.getRowObjects();
  return rows.reduce((acc, r) => acc + Number(r['cost']), 0);
}

describe('exclusion NULL-safety (DuckDB end-to-end)', () => {
  let conn: Conn;
  let dataDir: string;

  beforeAll(async () => {
    const db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-excl-'));
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
        line_item_usage_type VARCHAR,
        resource_tags MAP(VARCHAR, VARCHAR)
      )
    `);
    // Row A: EC2, team=sandbox,  $10 — matched by the exclusion rule
    // Row B: EC2, team=backend,  $20 — different tag value, must be kept
    // Row C: EC2, UNTAGGED,      $40 — the regression: NULL tag must be kept
    // Row D: S3,  team=sandbox,   $5 — matched on a different service
    await conn.run(`INSERT INTO cur VALUES
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', '', 'a', 'rA', 1, 10.0, 10.0, 'Usage', 'RunInstances', 'BoxUsage', MAP {'user_team': 'sandbox'}),
      (TIMESTAMP '2026-05-02', '111', 'acct', 'eu-central-1', 'AmazonEC2', '', 'b', 'rB', 1, 20.0, 20.0, 'Usage', 'RunInstances', 'BoxUsage', MAP {'user_team': 'backend'}),
      (TIMESTAMP '2026-05-03', '111', 'acct', 'eu-central-1', 'AmazonEC2', '', 'c', 'rC', 1, 40.0, 40.0, 'Usage', 'RunInstances', 'BoxUsage', MAP {}),
      (TIMESTAMP '2026-05-03', '111', 'acct', 'eu-central-1', 'AmazonS3', '', 'd', 'rD', 1, 5.0, 5.0, 'Usage', 'PutObject', 'Requests', MAP {'user_team': 'sandbox'})
    `);
    await conn.run(`COPY (SELECT * FROM cur) TO '${join(partDir, 'data.parquet')}' (FORMAT PARQUET)`);
  });

  async function scopedTotal(costScope: CostScopeConfig | undefined): Promise<number> {
    const { sql, params } = buildDailyCostsQuery(
      { groupBy: asDimensionId('service'), dateRange, filters: {}, granularity: 'daily' },
      { dataDir, dimensions, costScope },
    );
    return sumColumn(conn, substituteParams(sql, params));
  }

  it('baseline: no exclusions sees all four rows ($75)', async () => {
    expect(await scopedTotal(undefined)).toBeCloseTo(75, 6);
  });

  it('tag exclusion drops only the matching rows — untagged cost survives', async () => {
    const scope = scopeWith([{ dimensionId: asDimensionId('tag_team'), values: ['sandbox'] }]);
    // Excludes A ($10) and D ($5); keeps B ($20) and the UNTAGGED C ($40).
    expect(await scopedTotal(scope)).toBeCloseTo(60, 6);
  });

  it('tag exclusion for an absent value excludes nothing', async () => {
    const scope = scopeWith([{ dimensionId: asDimensionId('tag_team'), values: ['no-such-team'] }]);
    expect(await scopedTotal(scope)).toBeCloseTo(75, 6);
  });

  it('multi-condition rule with a tag condition keeps untagged rows', async () => {
    const scope = scopeWith([
      { dimensionId: asDimensionId('service'), values: ['AmazonEC2'] },
      { dimensionId: asDimensionId('tag_team'), values: ['sandbox'] },
    ]);
    // Excludes only A (EC2 AND sandbox). C is EC2 but untagged: NOT(TRUE AND NULL)
    // used to be NULL and dropped it.
    expect(await scopedTotal(scope)).toBeCloseTo(65, 6);
  });

  it('materialized base keeps untagged rows', async () => {
    const scope = scopeWith([{ dimensionId: asDimensionId('tag_team'), values: ['sandbox'] }]);
    const ddl = buildMaterializeBaseQuery('daily', dateRange, { dataDir, dimensions, costScope: scope });
    await conn.run(ddl);
    expect(await sumColumn(conn, 'SELECT SUM(cost) AS cost FROM cost_base')).toBeCloseTo(60, 6);
  });

  it('persisted rollup partition keeps untagged rows', async () => {
    const scope = scopeWith([{ dimensionId: asDimensionId('tag_team'), values: ['sandbox'] }]);
    const outPath = join(dataDir, 'rollup-2026-05.parquet');
    const ddl = buildRollupPartitionQuery('2026-05', 'daily', outPath, { dataDir, dimensions, costScope: scope });
    await conn.run(ddl);
    const escaped = outPath.replaceAll("'", "''");
    expect(await sumColumn(conn, `SELECT SUM(cost) AS cost FROM read_parquet('${escaped}')`)).toBeCloseTo(60, 6);
  });
});
