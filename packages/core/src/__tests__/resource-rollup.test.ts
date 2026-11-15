import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { buildResourceRowsQuery, buildResourceTopQuery, buildSource } from '../query/builder.js';
import { SecurityError } from '../query/identifier-validator.js';
import { resourceRollupDimensionColumns } from '../rollup/resource-rollup.js';
import { FIXTURE_PROVIDER_NAME } from '../__fixtures__/layout.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { asDimensionId, asProviderName, tagSqlColumn } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');
const PROVIDER = asProviderName(FIXTURE_PROVIDER_NAME);
const JANUARY = '2026-01';
/** Pairs kept per month: far fewer than the ~1,500 the fixture month holds. */
const PAIRS = 40;

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner', normalize: 'lowercase-kebab' }],
};
const costScope: CostScopeConfig = { costMetric: 'effective', rules: [] };
const TEAM = tagSqlColumn({ tagName: 'team' });

type Row = Record<string, unknown>;
type Connection = Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>;

async function queryAll(conn: Connection, sql: string): Promise<Row[]> {
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects();
}

function num(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? Number.NaN);
}

describe('resourceRollupDimensionColumns', () => {
  it('is the rollup grain plus the resource and its description', () => {
    expect(resourceRollupDimensionColumns(dimensions)).toEqual(['usage_date', 'account_id', 'account_name', 'service', TEAM, 'resource_id', 'description']);
  });

  it('lists a key column once when the grain already holds it', () => {
    const withResource: DimensionsConfig = {
      builtIn: [...dimensions.builtIn, { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' }],
      tags: [],
    };
    const columns = resourceRollupDimensionColumns(withResource);
    expect(columns.filter(c => c === 'resource_id')).toHaveLength(1);
    expect(columns.at(-1)).toBe('description');
  });
});

describe('resource rollup build queries', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Connection;
  let outDir: string;
  let topPath: string;
  let heavyPath: string;
  let rowsPath: string;

  const opts = { dataDir: SYNTHETIC_DIR, dimensions, providers: [{ name: PROVIDER, type: 'aws' as const, availablePeriods: [JANUARY] }], costScope };
  const raw = (): string => buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions, providers: [{ name: PROVIDER, type: 'aws', periods: [JANUARY] }], costMetric: 'effective' });
  const inJanuary = `usage_date >= '2026-01-01' AND usage_date < '2026-02-01'`;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    outDir = await mkdtemp(join(tmpdir(), 'cg-resource-rollup-'));
    topPath = join(outDir, 'top.parquet');
    heavyPath = join(outDir, 'heavy.parquet');
    rowsPath = join(outDir, 'rows.parquet');
    await conn.run(buildResourceTopQuery(JANUARY, 'daily', topPath, opts, PAIRS));
    await conn.run(`COPY (SELECT resource_id, description FROM read_parquet('${topPath}') WHERE rank <= ${String(PAIRS)}) TO '${heavyPath}' (FORMAT PARQUET)`);
    await conn.run(buildResourceRowsQuery(JANUARY, 'daily', rowsPath, heavyPath, opts));
  });
  afterAll(async () => { await rm(outDir, { recursive: true, force: true }); });

  it('ranks the month\'s pairs by weight and keeps one more than asked, as the tail bound', async () => {
    const top = await queryAll(conn, `SELECT resource_id, description, weight, rank FROM read_parquet('${topPath}') ORDER BY rank`);
    expect(top).toHaveLength(PAIRS + 1);
    expect(top.map(r => num(r['rank']))).toEqual(Array.from({ length: PAIRS + 1 }, (_, i) => i + 1));
    const weights = top.map(r => num(r['weight']));
    expect(weights).toEqual([...weights].sort((a, b) => b - a));

    // The weight is the sum of the line items' sizes, so a credit weighs as much as a charge.
    const expected = await queryAll(conn, `
      SELECT resource_id, description, CAST(SUM(ABS(cost)) AS DOUBLE) AS weight
      FROM ${raw()} WHERE ${inJanuary}
      GROUP BY resource_id, description
      ORDER BY weight DESC, resource_id, description LIMIT ${String(PAIRS + 1)}`);
    expect(top.map(r => [r['resource_id'], r['description']])).toEqual(expected.map(r => [r['resource_id'], r['description']]));
    top.forEach((r, i) => { expect(num(r['weight'])).toBeCloseTo(num(expected[i]?.['weight']), 6); });
  });

  it('keeps every pair, with no tail bound, when the month has fewer than asked', async () => {
    const allPath = join(outDir, 'top-all.parquet');
    await conn.run(buildResourceTopQuery(JANUARY, 'daily', allPath, opts, 100_000));
    const [counts] = await queryAll(conn, `
      SELECT (SELECT COUNT(*) FROM read_parquet('${allPath}')) AS kept,
             (SELECT COUNT(*) FROM (SELECT 1 FROM ${raw()} WHERE ${inJanuary} GROUP BY resource_id, description)) AS pairs`);
    expect(num(counts?.['kept'])).toBe(num(counts?.['pairs']));
    // A credit weighs as much as a charge of its size.
    const credit = await queryAll(conn, `SELECT weight FROM read_parquet('${allPath}') WHERE description = 'AWS promotional credit'`);
    expect(credit.map(r => num(r['weight']))).toEqual([75]);
  });

  it('bounds every pair it leaves out by the weight of the first one left out', async () => {
    const [bound] = await queryAll(conn, `SELECT weight FROM read_parquet('${topPath}') WHERE rank = ${String(PAIRS + 1)}`);
    const tailBound = num(bound?.['weight']);
    expect(tailBound).toBeGreaterThan(0);
    const [worst] = await queryAll(conn, `
      SELECT MAX(day_cost) AS worst FROM (
        SELECT resource_id, description, usage_date, ABS(SUM(cost)) AS day_cost
        FROM ${raw()} WHERE ${inJanuary}
          AND (resource_id, description) NOT IN (SELECT resource_id, description FROM read_parquet('${heavyPath}'))
        GROUP BY ALL)`);
    expect(num(worst?.['worst'])).toBeLessThanOrEqual(tailBound);
  });

  it('stores the heavy pairs\' rows, and nothing else, at the grain plus the pair', async () => {
    const columns = await queryAll(conn, `SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet('${rowsPath}'))`);
    expect(columns.map(c => c['column_name'])).toEqual([...resourceRollupDimensionColumns(dimensions), 'cost', 'list_cost', 'usage_amount', 'line_items']);
    const [stored] = await queryAll(conn, `SELECT COUNT(DISTINCT (resource_id, description)) AS pairs FROM read_parquet('${rowsPath}')`);
    expect(num(stored?.['pairs'])).toBe(PAIRS);
    const [strays] = await queryAll(conn, `
      SELECT COUNT(*) AS n FROM read_parquet('${rowsPath}')
      WHERE (resource_id, description) NOT IN (SELECT resource_id, description FROM read_parquet('${heavyPath}'))`);
    expect(num(strays?.['n'])).toBe(0);
  });

  it('reproduces every measure of a heavy pair, over any days and under a grain filter', async () => {
    const window = `usage_date BETWEEN '2026-01-05' AND '2026-01-20' AND ${TEAM} IS DISTINCT FROM 'platform'`;
    const measures = (source: string, lineItems: string): string => `
      SELECT resource_id, description, account_id,
        CAST(SUM(cost) AS DOUBLE) AS cost, CAST(SUM(list_cost) AS DOUBLE) AS list_cost,
        CAST(SUM(usage_amount) AS DOUBLE) AS usage_amount, CAST(${lineItems} AS DOUBLE) AS line_items
      FROM ${source} WHERE ${window}
      GROUP BY resource_id, description, account_id ORDER BY resource_id, description, account_id`;
    const rolled = await queryAll(conn, measures(`read_parquet('${rowsPath}')`, 'SUM(line_items)'));
    const expected = await queryAll(conn, measures(
      `(SELECT * FROM ${raw()} WHERE (resource_id, description) IN (SELECT resource_id, description FROM read_parquet('${heavyPath}')))`,
      'COUNT(*)',
    ));
    expect(rolled.length).toBeGreaterThan(5);
    expect(rolled).toHaveLength(expected.length);
    rolled.forEach((r, i) => {
      const e = expected[i];
      expect([r['resource_id'], r['description'], r['account_id']]).toEqual([e?.['resource_id'], e?.['description'], e?.['account_id']]);
      for (const m of ['cost', 'list_cost', 'usage_amount']) expect(num(r[m])).toBeCloseTo(num(e?.[m]), 6);
      expect(num(r['line_items'])).toBe(num(e?.['line_items']));
    });
  });

  it('leaves the cost scope\'s excluded rows out of both the weights and the rows', async () => {
    const scoped: CostScopeConfig = {
      costMetric: 'effective',
      rules: [{ id: 'no-tax', name: 'No tax', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('service'), values: ['Tax'] }] }],
    };
    const scopedTop = join(outDir, 'top-scoped.parquet');
    await conn.run(buildResourceTopQuery(JANUARY, 'daily', scopedTop, { ...opts, costScope: scoped }, PAIRS));
    const tax = await queryAll(conn, `SELECT 1 FROM read_parquet('${scopedTop}') WHERE description = 'VAT'`);
    expect(tax).toHaveLength(0);
    const unscoped = await queryAll(conn, `SELECT 1 FROM read_parquet('${topPath}') WHERE description = 'VAT'`);
    expect(unscoped).toHaveLength(1);
  });

  it('refuses a period, a pair count or a tier that is not one', () => {
    expect(() => buildResourceTopQuery('2026-1', 'daily', topPath, opts, PAIRS)).toThrow(SecurityError);
    expect(() => buildResourceTopQuery(JANUARY, 'daily', topPath, opts, 0)).toThrow(SecurityError);
    expect(() => buildResourceTopQuery(JANUARY, 'daily', topPath, opts, 1.5)).toThrow(SecurityError);
    expect(() => buildResourceRowsQuery(JANUARY, 'weekly', rowsPath, heavyPath, opts)).toThrow(SecurityError);
  });

  it('quote-escapes the paths it writes and reads', () => {
    const sql = buildResourceRowsQuery(JANUARY, 'daily', "/tmp/o'brien/rows.parquet", "/tmp/o'brien/heavy.parquet", opts);
    expect(sql).toContain("'/tmp/o''brien/rows.parquet'");
    expect(sql).toContain("'/tmp/o''brien/heavy.parquet'");
  });
});
