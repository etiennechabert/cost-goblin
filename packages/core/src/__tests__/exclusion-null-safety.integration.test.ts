import { describe, it, expect, beforeAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOCUS_TABLE_DDL } from '../__fixtures__/focus-fixture.js';
import {
  buildDailyCostsQuery,
  buildExclusionClauses,
  buildGrainProbeQuery,
  buildMaterializeBaseQuery,
  buildRollupPartitionQuery,
  buildRuleMatchExpr,
  buildSource,
  sqlStringLiteral,
} from '../query/builder.js';
import { rollupGrainColumns } from '../rollup/grain.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { asDateString, asDimensionId, asProviderName } from '../types/branded.js';

// #451: exclusion rules on a tag dimension used to drop every UNTAGGED row.
// Tag expressions are NULL when the tag is absent, `NULL NOT IN (...)` is
// NULL, and WHERE treats NULL as false — so "exclude team = sandbox" also
// removed all untagged spend, from live queries and from the persisted rollup.

const PROVIDER = asProviderName('aws');
const PERIOD = '2026-05';
const RANGE = { start: asDateString('2026-05-01'), end: asDateString('2026-05-31') };

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
  ],
  tags: [
    { tagName: 'team', label: 'Team' },
    // Account-only dimension: with no org-accounts join it projects a bare
    // NULL for every row, the extreme case of the bug.
    { label: 'Cost Center', accountTagFallback: 'cost-center' },
  ],
};

// One row each. Distinct powers of two make every subset sum unique, so a
// total pins down exactly which rows survived.
//   EC2 / team=sandbox   1
//   EC2 / team=platform  2
//   EC2 / untagged       4
//   S3  / untagged       8
const ALL_ROWS = 15;

function rule(id: string, conditions: ExclusionRule['conditions'], enabled = true): ExclusionRule {
  return { id, name: id, enabled, builtIn: false, conditions };
}

const sandboxTeam = rule('sandbox-team', [{ dimensionId: asDimensionId('tag_team'), values: ['sandbox'] }]);
const ec2Sandbox = rule('ec2-sandbox', [
  { dimensionId: asDimensionId('service'), values: ['EC2'] },
  { dimensionId: asDimensionId('tag_team'), values: ['sandbox'] },
]);
const sandboxThenEc2 = rule('sandbox-then-ec2', [
  { dimensionId: asDimensionId('tag_team'), values: ['sandbox'] },
  { dimensionId: asDimensionId('service'), values: ['EC2'] },
]);
const costCenter = rule('cost-center', [{ dimensionId: asDimensionId('tag_cost_center'), values: ['cc-1'] }]);
const s3Service = rule('s3', [{ dimensionId: asDimensionId('service'), values: ['S3'] }]);

function scope(rules: readonly ExclusionRule[]): CostScopeConfig {
  return { costMetric: 'effective', rules: [...rules] };
}

type Conn = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function scalar(conn: Conn, sql: string, column: string): Promise<number> {
  const rows = await (await conn.run(sql)).getRowObjects();
  return Number(rows[0]?.[column] ?? Number.NaN);
}

describe('exclusion rules keep untagged (NULL) rows (#451)', () => {
  let conn: Conn;
  let dataDir: string;
  let outDir: string;

  const opts = (rules: readonly ExclusionRule[]) => ({
    dataDir,
    dimensions,
    providers: [{ name: PROVIDER, availablePeriods: [PERIOD] }],
    costScope: scope(rules),
  });

  async function queryPathTotal(rules: readonly ExclusionRule[]): Promise<number> {
    const { sql, params } = buildDailyCostsQuery(
      { groupBy: asDimensionId('service'), dateRange: RANGE, filters: {}, granularity: 'daily' },
      opts(rules),
    );
    const prepared = await conn.prepare(sql);
    params.forEach((p, i) => { prepared.bindVarchar(i + 1, String(p)); });
    const rows = await (await prepared.run()).getRowObjects();
    return rows.reduce((sum, r) => sum + Number(r['cost']), 0);
  }

  async function materializedTotal(rules: readonly ExclusionRule[]): Promise<number> {
    await conn.run(buildMaterializeBaseQuery('daily', RANGE, opts(rules)));
    return scalar(conn, 'SELECT COALESCE(SUM(cost), 0) AS total FROM cost_base', 'total');
  }

  async function rollupTotal(rules: readonly ExclusionRule[], name: string): Promise<number> {
    const outPath = join(outDir, `${name}.parquet`);
    await conn.run(buildRollupPartitionQuery(PERIOD, 'daily', outPath, opts(rules)));
    return scalar(conn, `SELECT COALESCE(SUM(cost), 0) AS total FROM read_parquet(${sqlStringLiteral(outPath)})`, 'total');
  }

  async function probeLineItems(rules: readonly ExclusionRule[]): Promise<number> {
    return scalar(conn, buildGrainProbeQuery(PERIOD, rollupGrainColumns(dimensions), opts(rules)), 'line_items');
  }

  beforeAll(async () => {
    const db = await DuckDBInstance.create();
    conn = await db.connect();
    dataDir = await mkdtemp(join(tmpdir(), 'cg-exclusion-null-'));
    outDir = await mkdtemp(join(tmpdir(), 'cg-exclusion-null-out-'));
    const partDir = join(dataDir, 'aws', 'raw', `daily-${PERIOD}`);
    await mkdir(partDir, { recursive: true });

    await conn.run(FOCUS_TABLE_DDL);
    await conn.run(`
      INSERT INTO synthetic (ChargePeriodStart, SubAccountId, SubAccountName, ServiceName, ChargeCategory, EffectiveCost, BilledCost, Tags) VALUES
        (TIMESTAMP '2026-05-02', '111', 'prod', 'EC2', 'Usage', 1, 1, MAP {'team': 'sandbox'}),
        (TIMESTAMP '2026-05-02', '111', 'prod', 'EC2', 'Usage', 2, 2, MAP {'team': 'platform'}),
        (TIMESTAMP '2026-05-02', '111', 'prod', 'EC2', 'Usage', 4, 4, MAP {}),
        (TIMESTAMP '2026-05-02', '222', 'data', 'S3', 'Usage', 8, 8, MAP {})
    `);
    await conn.run(`COPY (SELECT * FROM synthetic) TO ${sqlStringLiteral(join(partDir, 'data.parquet'))} (FORMAT PARQUET)`);
  });

  describe.each([
    ['live query (parameterized)', queryPathTotal],
    ['materialized base (DDL literals)', materializedTotal],
  ])('%s', (_label, total) => {
    it('keeps every row when no rule is enabled', async () => {
      expect(await total([])).toBe(ALL_ROWS);
      expect(await total([{ ...sandboxTeam, enabled: false }])).toBe(ALL_ROWS);
    });

    it('single-condition tag rule drops only the tagged match', async () => {
      expect(await total([sandboxTeam])).toBe(ALL_ROWS - 1);
    });

    it('multi-condition rule drops only rows matching every condition, in either order', async () => {
      expect(await total([ec2Sandbox])).toBe(ALL_ROWS - 1);
      expect(await total([sandboxThenEc2])).toBe(ALL_ROWS - 1);
    });

    it('a rule on an all-NULL account-only dimension excludes nothing', async () => {
      expect(await total([costCenter])).toBe(ALL_ROWS);
    });

    it('built-in rules still drop their match (control)', async () => {
      expect(await total([s3Service])).toBe(ALL_ROWS - 8);
      expect(await total([s3Service, sandboxTeam])).toBe(ALL_ROWS - 8 - 1);
    });
  });

  it('rollup partitions keep untagged cost', async () => {
    expect(await rollupTotal([], 'none')).toBe(ALL_ROWS);
    expect(await rollupTotal([sandboxTeam], 'single')).toBe(ALL_ROWS - 1);
    expect(await rollupTotal([ec2Sandbox], 'multi')).toBe(ALL_ROWS - 1);
    expect(await rollupTotal([costCenter], 'account-only')).toBe(ALL_ROWS);
  });

  it('the grain probe counts the untagged line items the rollup will store', async () => {
    expect(await probeLineItems([])).toBe(4);
    expect(await probeLineItems([sandboxTeam])).toBe(3);
    expect(await probeLineItems([ec2Sandbox])).toBe(3);
  });

  it('positive matches are unchanged: an untagged row never matches a tag condition', async () => {
    // buildRuleMatchExpr also backs the Cost Scope preview (CASE WHEN) and the
    // Explorer's filter predicate; COALESCE(..., FALSE) must not widen them.
    const source = buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: PROVIDER }], costMetric: 'effective' });
    const matched = async (r: ExclusionRule): Promise<number> => {
      const expr = buildRuleMatchExpr(r, dimensions);
      if (expr === null) throw new Error(`rule ${r.id} produced no expression`);
      return scalar(conn, `SELECT COALESCE(SUM(CASE WHEN (${expr}) THEN cost ELSE 0 END), 0) AS hit FROM ${source}`, 'hit');
    };
    expect(await matched(sandboxTeam)).toBe(1);
    expect(await matched(ec2Sandbox)).toBe(1);
    expect(await matched(costCenter)).toBe(0);
  });

  it('account rules written as display names resolve through the reverse map', async () => {
    // The Cost Scope preview built its match expressions without the map, so a
    // rule on account "prod" previewed as $0 while dashboards excluded its spend.
    const byName = rule('prod-account', [{ dimensionId: asDimensionId('account'), values: ['prod'] }]);
    const reverse = new Map([['prod', ['111']]]);
    const expr = buildRuleMatchExpr(byName, dimensions, reverse);
    expect(expr).toBe("COALESCE(account_id IN ('111'), FALSE)");
    expect(buildRuleMatchExpr(byName, dimensions)).toBe("COALESCE(account_id IN ('prod'), FALSE)");
    const { sql, params } = buildDailyCostsQuery(
      { groupBy: asDimensionId('service'), dateRange: RANGE, filters: {}, granularity: 'daily' },
      { ...opts([byName]), accountReverseMap: reverse },
    );
    const prepared = await conn.prepare(sql);
    params.forEach((p, i) => { prepared.bindVarchar(i + 1, String(p)); });
    const rows = await (await prepared.run()).getRowObjects();
    expect(rows.reduce((sum, r) => sum + Number(r['cost']), 0)).toBe(8); // only account 222 (S3) left
  });

  it('literal-mode clauses (no QueryBuilder) escape rule values', () => {
    const quoted = rule('quoted', [{ dimensionId: asDimensionId('tag_team'), values: ["o'brien"] }]);
    const [clause] = buildExclusionClauses([quoted], dimensions, undefined);
    expect(clause).toContain("'o''brien'");
  });
});
