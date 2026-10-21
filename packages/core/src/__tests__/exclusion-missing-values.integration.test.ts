import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCostQuery, buildEntityDetailQuery, buildExclusionClauses, buildFilterClauses, buildRollupPartitionQuery, buildRuleMatchExpr, buildSource, buildTrendQuery, sqlStringLiteral } from '../query/builder.js';
import { QueryBuilder } from '../query/parameterized.js';
import { asDateString, asDimensionId, asDollars, asEntityRef, asProviderName, asTagValue, tagDimColumn } from '../types/branded.js';
import type { DimensionsConfig, TagDimension } from '../types/config.js';
import type { ExclusionCondition, ExclusionRule } from '../types/cost-scope.js';
import type { FilterMap } from '../types/query.js';

/**
 * Exclusion rules against rows that have no value for the rule's dimension,
 * on real Parquet through real DuckDB. A tag rule used to drop every untagged
 * row too (`NOT (NULL IN (…))` is NULL, and WHERE drops NULL) while the Cost
 * Scope preview counted those rows as kept; `matchMissing` is the explicit
 * way to exclude them. Each rule is checked on the three paths that apply
 * exclusions: a live query's bound WHERE, a rollup partition's literal WHERE,
 * and the preview's CASE WHEN. A dashboard filter on '' (a click on a
 * widget's group of rows with no value) is checked on the live source and a
 * rollup, and the cost and trend group-bys return that group as one row.
 */

const PROVIDER = asProviderName('aws');
const TEAM: TagDimension = { tagName: 'team', label: 'Team', normalize: 'lowercase-kebab', aliases: { platform: ['infra'] } };
const TEAM_ID = asDimensionId(tagDimColumn(TEAM));
const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [TEAM],
};

// One power of two per row, so every total names exactly the rows it kept.
const ROW_COST = { sandbox: 1, platform: 2, untagged: 4, emptyTag: 8, noAccount: 16, noRegion: 32 } as const;
const TOTAL = Object.values(ROW_COST).reduce((a, b) => a + b, 0);

function rule(...conditions: ExclusionCondition[]): ExclusionRule {
  return { id: 'r', name: 'r', enabled: true, builtIn: false, conditions };
}
const team = (values: string[], matchMissing?: true): ExclusionCondition => ({ dimensionId: TEAM_ID, values, ...(matchMissing ? { matchMissing } : {}) });

/** Positional $1..$n binding, mirroring the duckdb-worker's. */
async function runPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const stmt = await conn.prepare(sql);
  try {
    params.forEach((value, i) => {
      if (typeof value === 'string') stmt.bindVarchar(i + 1, value);
      else if (typeof value === 'number' && Number.isInteger(value)) stmt.bindInteger(i + 1, value);
      else if (typeof value === 'number') stmt.bindDouble(i + 1, value);
      else throw new Error(`unexpected query parameter ${String(value)}`);
    });
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJson();
  } finally {
    stmt.destroySync();
  }
}

describe('exclusion rules and missing values (DuckDB execution)', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = (await mkdtemp(join(tmpdir(), 'cg-excl-missing-'))).replaceAll('\\', '/');
    const monthDir = join(dataDir, 'aws', 'raw', 'daily-2026-01');
    await mkdir(monthDir, { recursive: true });
    db = await DuckDBInstance.create();
    conn = await db.connect();
    const row = (account: string, region: string, tags: string, cost: number): string =>
      `(TIMESTAMP '2026-01-05 00:00:00', ${account}, 'Acct', ${region}, 'Amazon EC2', 'AmazonEC2', 'Compute', 'usage',
        1.0, ${String(cost)}, 'arn:res', ${String(cost)}, 'Usage', 'Standard', '', 'RunInstances', 'BoxUsage', ${tags})`;
    await conn.run(`
      COPY (
        SELECT * FROM (VALUES
          ${row("'111'", "'eu-west-1'", "MAP {'team': 'sandbox'}", ROW_COST.sandbox)},
          ${row("'111'", "'eu-west-1'", "MAP {'team': 'infra'}", ROW_COST.platform)},
          ${row("'111'", "'eu-west-1'", "MAP {'env': 'prod'}", ROW_COST.untagged)},
          ${row("'111'", "'eu-west-1'", "MAP {'team': ''}", ROW_COST.emptyTag)},
          ${row('NULL', "'eu-west-1'", "MAP {'team': 'infra'}", ROW_COST.noAccount)},
          ${row("'222'", 'NULL', "MAP {'team': 'infra'}", ROW_COST.noRegion)}
        ) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
               ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
               ConsumedQuantity, ListCost, ResourceId, EffectiveCost,
               ChargeCategory, PricingCategory, CommitmentDiscountStatus,
               x_Operation, SkuMeter, Tags)
      ) TO ${sqlStringLiteral(join(monthDir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
    `);
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(dataDir, { recursive: true, force: true });
  });

  const source = (): string => buildSource({ dataDir, tier: 'daily', dimensions, providers: [{ name: PROVIDER, type: 'aws', periods: ['2026-01'] }], costMetric: 'effective' });

  /** What a live query keeps: the WHERE clauses with values bound. */
  async function liveTotal(rules: readonly ExclusionRule[]): Promise<number> {
    const qb = new QueryBuilder();
    const clauses = buildExclusionClauses(rules, dimensions, undefined, qb);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const [r] = await runPrepared(conn, `SELECT SUM(cost)::DOUBLE AS total FROM ${source()} ${where}`, qb.build().params);
    return Number(r?.['total']);
  }

  /** A rollup partition built with these rules (over `dims`' grain), as a source to read. */
  async function rollupPartition(rules: readonly ExclusionRule[], dims: DimensionsConfig = dimensions): Promise<string> {
    const outPath = join(dataDir, `rollup-${String(Math.random()).slice(2)}.parquet`).replaceAll('\\', '/');
    await conn.run(buildRollupPartitionQuery('2026-01', 'daily', outPath, {
      dataDir, dimensions: dims, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: ['2026-01'] }], costScope: { costMetric: 'effective', rules },
    }));
    return `read_parquet(${sqlStringLiteral(outPath)})`;
  }

  /** What a rollup partition stores: the same rules as escaped literals. */
  async function rollupTotal(rules: readonly ExclusionRule[]): Promise<number> {
    const [r] = await runPrepared(conn, `SELECT COALESCE(SUM(cost), 0)::DOUBLE AS total FROM ${await rollupPartition(rules)}`, []);
    return Number(r?.['total']);
  }

  /** What a dashboard filter keeps, read off the raw source and off a rollup. */
  async function filteredTotals(filters: FilterMap): Promise<{ live: number; rollup: number }> {
    const qb = new QueryBuilder();
    const where = buildFilterClauses(filters, dimensions, undefined, qb).join(' AND ');
    const { params } = qb.build();
    const total = async (from: string): Promise<number> => {
      const [r] = await runPrepared(conn, `SELECT COALESCE(SUM(cost), 0)::DOUBLE AS total FROM ${from} WHERE ${where}`, params);
      return Number(r?.['total']);
    };
    return { live: await total(source()), rollup: await total(await rollupPartition([])) };
  }

  /** What the Cost Scope preview reports as kept. */
  async function previewKept(r: ExclusionRule): Promise<number> {
    const expr = buildRuleMatchExpr(r, dimensions) ?? 'FALSE';
    const [row] = await runPrepared(conn, `SELECT SUM(CASE WHEN (${expr}) THEN 0 ELSE cost END)::DOUBLE AS kept FROM ${source()}`, []);
    return Number(row?.['kept']);
  }

  const cases: { readonly name: string; readonly rule: ExclusionRule; readonly excluded: number }[] = [
    { name: 'a tag value keeps the untagged rows', rule: rule(team(['sandbox'])), excluded: ROW_COST.sandbox },
    { name: 'an aliased tag value keeps the untagged rows', rule: rule(team(['infra'])), excluded: ROW_COST.platform + ROW_COST.noAccount + ROW_COST.noRegion },
    { name: 'missing tag values: absent key and empty value', rule: rule(team([], true)), excluded: ROW_COST.untagged + ROW_COST.emptyTag },
    { name: 'a tag value or missing', rule: rule(team(['sandbox'], true)), excluded: ROW_COST.sandbox + ROW_COST.untagged + ROW_COST.emptyTag },
    {
      name: 'missing account: the NULL SubAccountId shown as (no account)',
      rule: rule({ dimensionId: asDimensionId('account'), values: [], matchMissing: true }),
      excluded: ROW_COST.noAccount,
    },
    {
      name: 'the (no account) value itself, typed as a value',
      rule: rule({ dimensionId: asDimensionId('account'), values: ['(no account)'] }),
      excluded: ROW_COST.noAccount,
    },
    { name: 'missing built-in field', rule: rule({ dimensionId: asDimensionId('region'), values: [], matchMissing: true }), excluded: ROW_COST.noRegion },
    {
      // An untagged row matching the other condition used to make the whole
      // AND NULL — and be dropped.
      name: 'a multi-condition rule keeps untagged rows its other conditions match',
      rule: rule(team(['sandbox']), { dimensionId: asDimensionId('account'), values: ['111'] }),
      excluded: ROW_COST.sandbox,
    },
    {
      name: 'a multi-condition rule with missing values ANDs the whole condition',
      rule: rule(team(['sandbox'], true), { dimensionId: asDimensionId('region'), values: ['eu-west-1'] }),
      excluded: ROW_COST.sandbox + ROW_COST.untagged + ROW_COST.emptyTag,
    },
  ];

  for (const c of cases) {
    it(`${c.name} — live query, rollup and preview agree`, async () => {
      const kept = TOTAL - c.excluded;
      expect(await liveTotal([c.rule])).toBe(kept);
      expect(await rollupTotal([c.rule])).toBe(kept);
      expect(await previewKept(c.rule)).toBe(kept);
    });
  }

  it('applies several rules as a union of exclusions', async () => {
    const rules = [rule(team(['sandbox'])), rule({ dimensionId: asDimensionId('account'), values: [], matchMissing: true })];
    const kept = TOTAL - ROW_COST.sandbox - ROW_COST.noAccount;
    expect(await liveTotal(rules)).toBe(kept);
    expect(await rollupTotal(rules)).toBe(kept);
  });

  // A widget shows the line items with no value as one group named '', so a
  // click on it filters on ''. The filter keeps that whole group.
  const filterCases: { readonly name: string; readonly filters: FilterMap; readonly kept: number }[] = [
    { name: "'' keeps the untagged rows and the empty-tagged ones", filters: { [TEAM_ID]: [asTagValue('')] }, kept: ROW_COST.untagged + ROW_COST.emptyTag },
    {
      name: "a value and '' keep both",
      filters: { [TEAM_ID]: [asTagValue('sandbox'), asTagValue('')] },
      kept: ROW_COST.sandbox + ROW_COST.untagged + ROW_COST.emptyTag,
    },
    { name: 'a value alone keeps only its rows', filters: { [TEAM_ID]: [asTagValue('sandbox')] }, kept: ROW_COST.sandbox },
    { name: "'' on a built-in field keeps its empty rows", filters: { [asDimensionId('region')]: [asTagValue('')] }, kept: ROW_COST.noRegion },
    { name: "'' on the account keeps the charges with no account", filters: { [asDimensionId('account')]: [asTagValue('')] }, kept: ROW_COST.noAccount },
  ];

  for (const c of filterCases) {
    it(`filter: ${c.name} — live query and rollup agree`, async () => {
      expect(await filteredTotals(c.filters)).toEqual({ live: c.kept, rollup: c.kept });
    });
  }

  it("details the group with no value as the filter on '' keeps it", async () => {
    const detailTotal = async (entity: string): Promise<number> => {
      const { sql, params } = buildEntityDetailQuery(
        { entity: asEntityRef(entity), dimension: TEAM_ID, dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') }, filters: {} },
        { dataDir, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: ['2026-01'] }] },
      );
      const [r] = await runPrepared(conn, `SELECT COALESCE(SUM(cost), 0)::DOUBLE AS total FROM (${sql})`, params);
      return Number(r?.['total']);
    };
    expect(await detailTotal('')).toBe(ROW_COST.untagged + ROW_COST.emptyTag);
    expect(await detailTotal('sandbox')).toBe(ROW_COST.sandbox);
  });

  // The rows read NULL as '' (and '' is what the filter above keeps), so an
  // untagged group beside an empty-valued one came back as two rows read
  // alike: one was dropped where rows are kept per entity, and the untagged
  // one never joined its per-service breakdown.
  const JANUARY = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };
  const PLATFORM = ROW_COST.platform + ROW_COST.noAccount + ROW_COST.noRegion;
  const NO_VALUE = ROW_COST.untagged + ROW_COST.emptyTag;

  it("groups costs with no value as one '' entity, its service breakdown included — live query and rollup agree", async () => {
    // A rollup stores the untagged and the empty-tagged rows as separate grain
    // rows, so the group-by must merge them there too. The app's grain carries
    // the service column the cost query breaks down by; this suite's doesn't.
    const withService: DimensionsConfig = { ...dimensions, builtIn: [...dimensions.builtIn, { name: asDimensionId('service'), label: 'Service', field: 'service' }] };
    const costRows = async (materializedSource: string | undefined): Promise<unknown[]> => {
      const { sql, params } = buildCostQuery(
        { groupBy: TEAM_ID, dateRange: JANUARY, filters: {} },
        { dataDir, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: ['2026-01'] }], materializedSource },
      );
      const rows = await runPrepared(conn, sql, params);
      return rows.map(r => ({ entity: r['entity'], total: Number(r['total_cost']), service: r['service'], serviceCost: Number(r['service_cost']) }));
    };
    const expected = [
      { entity: 'platform', total: PLATFORM, service: 'Amazon EC2', serviceCost: PLATFORM },
      { entity: '', total: NO_VALUE, service: 'Amazon EC2', serviceCost: NO_VALUE },
      { entity: 'sandbox', total: ROW_COST.sandbox, service: 'Amazon EC2', serviceCost: ROW_COST.sandbox },
    ];
    expect(await costRows(undefined)).toEqual(expected);
    expect(await costRows(await rollupPartition([], withService))).toEqual(expected);
  });

  it("compares costs with no value as one '' trend row", async () => {
    const { sql, params } = buildTrendQuery(
      { groupBy: TEAM_ID, dateRange: JANUARY, filters: {}, deltaThreshold: asDollars(0), percentThreshold: 0 },
      { dataDir, dimensions, providers: [{ name: PROVIDER, type: 'aws', availablePeriods: ['2026-01'] }] },
    );
    const rows = await runPrepared(conn, sql, params);
    expect(rows.map(r => [r['entity'], Number(r['current_cost']), Number(r['previous_cost'])])).toEqual([
      ['platform', PLATFORM, 0],
      ['', NO_VALUE, 0],
      ['sandbox', ROW_COST.sandbox, 0],
    ]);
  });
});
