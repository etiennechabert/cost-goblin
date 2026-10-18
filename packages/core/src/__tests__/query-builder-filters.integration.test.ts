import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCostQuery,
  buildEntityDetailQuery,
  buildGrainProbeQuery,
  buildMaterializeBaseQuery,
  buildRollupPartitionQuery,
  sqlStringLiteral,
} from '../query/builder.js';
import type { QueryContextOptions } from '../query/builder.js';
import { SecurityError } from '../query/identifier-validator.js';
import { rollupGrainColumns } from '../rollup/grain.js';
import { asDateString, asDimensionId, asEntityRef, asProviderName, asTagValue, tagDimColumn, tagSqlColumn } from '../types/branded.js';
import type { DimensionsConfig, OrgNode, TagDimension } from '../types/config.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import type { FilterMap } from '../types/query.js';

/**
 * The filter, entity and DDL builders on real Parquet through real DuckDB:
 * multi-value, account-name and org-tree-node filters bound as parameters,
 * the org-node restriction, the materialized base table, a December rollup
 * partition's upper bound, and the grain probe with exclusions.
 */

const PROVIDER = asProviderName('aws');
const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [TEAM],
};

// One power of two per row, so every total names exactly the rows it kept.
// January's file holds four rows; December's holds one December row and one
// late-arriving row dated 2026-01-01.
const JAN_ROWS = [
  { day: '2026-01-05', account: '111', name: 'Prod A', region: 'eu-west-1', service: 'Amazon EC2', team: 'core', cost: 1 },
  { day: '2026-01-06', account: '222', name: 'Prod B', region: 'us-east-1', service: 'Amazon S3', team: 'core', cost: 2 },
  { day: '2026-01-07', account: '333', name: 'Dev', region: 'eu-west-1', service: 'Amazon RDS', team: 'data', cost: 4 },
  { day: '2026-01-08', account: '444', name: 'Sandbox', region: 'eu-west-1', service: 'Amazon EC2', team: 'sandbox', cost: 8 },
] as const;
const DEC_ROWS = [
  { day: '2025-12-30', account: '111', name: 'Prod A', region: 'eu-west-1', service: 'Amazon EC2', team: 'core', cost: 16 },
  { day: '2026-01-01', account: '111', name: 'Prod A', region: 'eu-west-1', service: 'Amazon EC2', team: 'core', cost: 32 },
] as const;

const JAN = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };
const REVERSE = new Map<string, readonly string[]>([['Prod', ['111', '222']]]);

function rule(dimensionId: string, values: string[]): ExclusionRule {
  return { id: `r-${dimensionId}`, name: 'r', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId(dimensionId), values }] };
}
const scope = (...rules: ExclusionRule[]): CostScopeConfig => ({ costMetric: 'effective', rules });

function filters(entries: Record<string, readonly string[]>): FilterMap {
  const map: Record<string, readonly ReturnType<typeof asTagValue>[]> = {};
  for (const [id, values] of Object.entries(entries)) map[asDimensionId(id)] = values.map(v => asTagValue(v));
  return map;
}

/** Positional $1..$n binding, mirroring the duckdb-worker's. */
async function runPrepared(conn: DuckDBConnection, sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]> {
  const stmt = await conn.prepare(sql);
  try {
    params.forEach((value, i) => {
      if (typeof value === 'string') stmt.bindVarchar(i + 1, value);
      else if (typeof value === 'number' && Number.isInteger(value)) stmt.bindInteger(i + 1, value);
      else throw new Error(`unexpected query parameter ${String(value)}`);
    });
    const reader = await stmt.runAndReadAll();
    return reader.getRowObjectsJson();
  } finally {
    stmt.destroySync();
  }
}

/** entity → total_cost, from a cost query's (entity, service) rows. */
function totalsByEntity(rows: readonly Record<string, unknown>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r['entity'])] = Number(r['total_cost']);
  return out;
}

describe('query builders on DuckDB', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;
  let dataDir: string;
  let opts: QueryContextOptions;

  beforeAll(async () => {
    dataDir = (await mkdtemp(join(tmpdir(), 'cg-builder-filters-'))).replaceAll('\\', '/');
    db = await DuckDBInstance.create();
    conn = await db.connect();
    const writeMonth = async (month: string, rows: readonly (typeof JAN_ROWS[number] | typeof DEC_ROWS[number])[]): Promise<void> => {
      const dir = join(dataDir, 'aws', 'raw', `daily-${month}`);
      await mkdir(dir, { recursive: true });
      const values = rows.map(r =>
        `(TIMESTAMP '${r.day} 00:00:00', '${r.account}', '${r.name}', '${r.region}', '${r.service}', 'code', 'Compute', 'usage',
          1.0, ${String(r.cost)}, 'arn:${r.account}', ${String(r.cost)}, 'Usage', 'Standard', '', 'RunInstances', 'BoxUsage', MAP {'team': '${r.team}'})`);
      await conn.run(`
        COPY (
          SELECT * FROM (VALUES ${values.join(',\n')}) AS t(ChargePeriodStart, SubAccountId, SubAccountName, RegionId,
                 ServiceName, x_ServiceCode, ServiceCategory, ChargeDescription,
                 ConsumedQuantity, ListCost, ResourceId, EffectiveCost,
                 ChargeCategory, PricingCategory, CommitmentDiscountStatus,
                 x_Operation, SkuMeter, Tags)
        ) TO ${sqlStringLiteral(join(dir, 'data.parquet').replaceAll('\\', '/'))} (FORMAT PARQUET)
      `);
    };
    await writeMonth('2026-01', JAN_ROWS);
    await writeMonth('2025-12', DEC_ROWS);
    opts = { dataDir, dimensions, providers: [{ name: PROVIDER, availablePeriods: ['2025-12', '2026-01'] }] };
  });

  afterAll(async () => {
    conn.disconnectSync();
    db.closeSync();
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('bound filters', () => {
    it('applies a multi-value IN filter through bound parameters', async () => {
      const q = buildCostQuery({ groupBy: asDimensionId('account'), dateRange: JAN, filters: filters({ service: ['Amazon EC2', 'Amazon S3'] }) }, opts);
      // Filter values are bound first, then the date range.
      expect(q.sql).toContain('WHERE usage_date BETWEEN $3 AND $4 AND service IN ($1, $2)');
      expect(q.params.slice(0, 2)).toEqual(['Amazon EC2', 'Amazon S3']);
      expect(q.sql).not.toContain("'Amazon EC2'");
      expect(totalsByEntity(await runPrepared(conn, q.sql, q.params))).toEqual({ '111': 1, '222': 2, '444': 8 });
    });

    it('expands an account display name to all its account ids', async () => {
      const q = buildCostQuery(
        { groupBy: asDimensionId('account'), dateRange: JAN, filters: filters({ account: ['Prod'] }) },
        { ...opts, accountReverseMap: REVERSE },
      );
      expect(q.sql).toContain('WHERE usage_date BETWEEN $3 AND $4 AND account_id IN ($1, $2)');
      expect(q.params.slice(0, 2)).toEqual(['111', '222']);
      expect(totalsByEntity(await runPrepared(conn, q.sql, q.params))).toEqual({ '111': 1, '222': 2 });
    });

    it('restricts the entities to an org node', async () => {
      const q = buildCostQuery({ groupBy: asDimensionId('account'), dateRange: JAN, filters: {}, orgNodeValues: ['333', '444'] }, opts);
      expect(totalsByEntity(await runPrepared(conn, q.sql, q.params))).toEqual({ '333': 4, '444': 8 });
    });

    it('keeps every value under the org-tree node a filter on the owner dimension names', async () => {
      const team = asDimensionId(tagDimColumn(TEAM));
      const orgTree: readonly OrgNode[] = [{ name: 'Eng', virtual: true, children: [{ name: 'core' }, { name: 'data' }] }];
      const owned: QueryContextOptions = { ...opts, dimensions: { ...dimensions, tags: [{ ...TEAM, concept: 'owner' }] }, orgTree };
      const byNode = (filterValues: readonly string[], o: QueryContextOptions) =>
        buildCostQuery({ groupBy: asDimensionId('account'), dateRange: JAN, filters: filters({ [team]: filterValues }) }, o);

      const q = byNode(['Eng'], owned);
      expect(q.params.slice(0, 3)).toEqual(['Eng', 'core', 'data']);
      expect(totalsByEntity(await runPrepared(conn, q.sql, q.params))).toEqual({ '111': 1, '222': 2, '333': 4 });
      const withNone = byNode(['Eng', ''], owned);
      expect(totalsByEntity(await runPrepared(conn, withNone.sql, withNone.params))).toEqual({ '111': 1, '222': 2, '333': 4 });

      // Without the tree, or on a tag that isn't the owner, the name is a value like any other.
      for (const o of [{ ...owned, orgTree: undefined }, { ...opts, orgTree }]) {
        const plain = byNode(['Eng'], o);
        expect(await runPrepared(conn, plain.sql, plain.params)).toEqual([]);
      }

      const detail = buildEntityDetailQuery({ entity: asEntityRef('Eng'), dimension: team, dateRange: JAN, filters: {} }, owned);
      expect((await runPrepared(conn, detail.sql, detail.params)).map(r => [r['account_id'], Number(r['cost'])])).toEqual([
        ['111', 1], ['222', 2], ['333', 4],
      ]);
    });

    it('drills into every account behind a display name', async () => {
      const q = buildEntityDetailQuery(
        { entity: asEntityRef('Prod'), dimension: asDimensionId('account'), dateRange: JAN, filters: {} },
        { ...opts, accountReverseMap: REVERSE },
      );
      const rows = await runPrepared(conn, q.sql, q.params);
      expect(rows.map(r => [r['usage_date'], r['account_id'], Number(r['cost'])])).toEqual([
        ['2026-01-05', '111', 1],
        ['2026-01-06', '222', 2],
      ]);
    });
  });

  describe('buildMaterializeBaseQuery', () => {
    async function baseTotal(range: { start: string; end: string }, costScope?: CostScopeConfig): Promise<number> {
      await conn.run(buildMaterializeBaseQuery('daily', range, { ...opts, ...(costScope === undefined ? {} : { costScope }) }));
      const [r] = await runPrepared(conn, 'SELECT COALESCE(SUM(cost), 0)::DOUBLE AS total FROM cost_base', []);
      return Number(r?.['total']);
    }

    it('materializes the range, inclusive on both ends', async () => {
      expect(await baseTotal(JAN)).toBe(15);
      expect(await baseTotal({ start: '2026-01-06', end: '2026-01-07' })).toBe(6);
    });

    it('drops the rows an exclusion rule matches', async () => {
      expect(await baseTotal(JAN, scope(rule('account', ['444'])))).toBe(7);
    });

    it('keeps only the slim columns', async () => {
      await conn.run(buildMaterializeBaseQuery('daily', JAN, opts));
      const columns = (await runPrepared(conn, 'DESCRIBE cost_base', [])).map(r => r['column_name']);
      expect(columns).toEqual(expect.arrayContaining(['usage_date', 'account_id', 'service', 'cost', tagSqlColumn(TEAM)]));
      expect(columns).not.toEqual(expect.arrayContaining(['description']));
      expect(columns).not.toEqual(expect.arrayContaining(['list_cost']));
    });

    it('refuses a date bound that is not YYYY-MM-DD', () => {
      expect(() => buildMaterializeBaseQuery('daily', { start: "2026-01-01' OR '1'='1", end: '2026-01-31' }, opts)).toThrow(SecurityError);
    });
  });

  describe('buildRollupPartitionQuery', () => {
    async function partition(period: string): Promise<{ total: number; lineItems: number }> {
      const outPath = join(dataDir, `rollup-${period}.parquet`).replaceAll('\\', '/');
      await conn.run(buildRollupPartitionQuery(period, 'daily', outPath, opts));
      const [r] = await runPrepared(
        conn,
        `SELECT COALESCE(SUM(cost), 0)::DOUBLE AS total, COALESCE(SUM(line_items), 0)::DOUBLE AS n FROM read_parquet(${sqlStringLiteral(outPath)})`,
        [],
      );
      return { total: Number(r?.['total']), lineItems: Number(r?.['n']) };
    }

    it('bounds a December partition at the next year\'s first day', async () => {
      // The late 2026-01-01 row in December's file belongs to January.
      expect(await partition('2025-12')).toEqual({ total: 16, lineItems: 1 });
    });

    it('takes every row of an ordinary month', async () => {
      expect(await partition('2026-01')).toEqual({ total: 15, lineItems: 4 });
    });
  });

  describe('buildGrainProbeQuery', () => {
    async function probe(costScope?: CostScopeConfig): Promise<Record<string, unknown>> {
      const sql = buildGrainProbeQuery('2026-01', rollupGrainColumns(dimensions), { ...opts, ...(costScope === undefined ? {} : { costScope }) });
      const [r] = await runPrepared(conn, sql, []);
      if (r === undefined) throw new Error('no probe row');
      return r;
    }

    it('counts the line items and distinct grain rows of the month', async () => {
      const r = await probe();
      expect(Number(r['line_items'])).toBe(4);
      expect(Number(r['grain_rows'])).toBe(4);
    });

    it('leaves out the rows an exclusion rule drops', async () => {
      const r = await probe(scope(rule(tagDimColumn(TEAM), ['sandbox'])));
      expect(Number(r['line_items'])).toBe(3);
      expect(Number(r['grain_rows'])).toBe(3);
    });
  });
});
