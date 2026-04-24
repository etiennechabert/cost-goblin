import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCostQuery, buildDailyCostsQuery, buildMissingTagsQuery, buildNonResourceCostQuery, buildEntityDetailQuery, buildSource } from '../query/builder.js';
import { buildSource as rebuildSource } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asDateString, asDollars, asEntityRef, asTagValue } from '../types/branded.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '__fixtures__', 'synthetic');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account_id'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
  ],
  tags: [
    {
      tagName: 'team',
      label: 'Team',
      concept: 'owner',
      normalize: 'lowercase-kebab',
      aliases: {
        'core-banking': ['core_banking', 'corebanking'],
      },
    },
    {
      tagName: 'environment',
      label: 'Environment',
      concept: 'environment',
      normalize: 'lowercase',
      aliases: {
        'production': ['prod', 'prd'],
      },
    },
  ],
};

interface QueryRow {
  [key: string]: unknown;
}

async function queryAll(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string): Promise<QueryRow[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));
  const rows: QueryRow[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: QueryRow = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

/**
 * For integration testing only: substitutes parameters into SQL.
 * In production, the worker thread uses real prepared statements.
 */
function substituteParams(sql: string, params: readonly unknown[]): string {
  let result = sql;
  for (let i = params.length; i >= 1; i--) {
    const param = params[i - 1];
    const placeholder = '$' + String(i);
    const value = typeof param === 'string' ? `'${param}'` : String(param);
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

async function queryAllPrepared(conn: Awaited<ReturnType<Awaited<ReturnType<typeof DuckDBInstance.create>>['connect']>>, sql: string, params: readonly unknown[]): Promise<QueryRow[]> {
  // For integration tests, substitute params back into SQL
  // (Production code uses real prepared statements via the worker)
  const substitutedSql = substituteParams(sql, params);
  return queryAll(conn, substitutedSql);
}

describe('DuckDB query integration', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(() => {
    // DuckDB Node API handles cleanup automatically
  });

  it('reads fixture parquet files', async () => {
    const source = buildSource(SYNTHETIC_DIR, 'daily', dimensions);
    const rows = await queryAll(conn, `SELECT COUNT(*) as cnt FROM ${source}`);
    expect(Number(rows[0]?.['cnt'])).toBeGreaterThan(0);
  });

  it('narrowed source with specific months reads the same data as the wildcard', async () => {
    // Synthetic fixtures: daily-2026-01/ and daily-2026-02/.
    const wide = buildSource(SYNTHETIC_DIR, 'daily', dimensions);
    const narrow = buildSource(SYNTHETIC_DIR, 'daily', dimensions, undefined, ['2026-01', '2026-02']);
    const [[wideRow], [narrowRow]] = await Promise.all([
      queryAll(conn, `SELECT COUNT(*) as cnt, SUM(cost) as total FROM ${wide}`),
      queryAll(conn, `SELECT COUNT(*) as cnt, SUM(cost) as total FROM ${narrow}`),
    ]);
    expect(Number(narrowRow?.['cnt'])).toBe(Number(wideRow?.['cnt']));
    expect(Number(narrowRow?.['total'])).toBeCloseTo(Number(wideRow?.['total']), 4);
  });

  it('narrowed source with a missing month directory errors — fs intersection is required', async () => {
    // Verified behavior: DuckDB's read_parquet errors on a glob pattern that
    // matches zero files, even when other patterns in the list match. Callers
    // must intersect required periods with what's actually on disk BEFORE
    // passing to buildSource. The query handlers do this via listLocalMonths.
    const source = rebuildSource(SYNTHETIC_DIR, 'daily', dimensions, undefined, ['2025-11']);
    await expect(queryAll(conn, `SELECT COUNT(*) as cnt FROM ${source}`))
      .rejects.toThrow(/No files found/);
  });

  it('queries costs grouped by service', async () => {
    const result = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);
    const firstRow = rows[0];
    expect(firstRow?.['entity']).toBeDefined();
    expect(firstRow?.['total_cost']).toBeDefined();
  });

  it('queries costs with filter', async () => {
    const resultAll = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const resultFiltered = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: { [asDimensionId('region')]: asTagValue('eu-central-1') },
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const allRows = await queryAllPrepared(conn, `SELECT SUM(total_cost) as t FROM (${resultAll.sql})`, resultAll.params);
    const filteredRows = await queryAllPrepared(conn, `SELECT SUM(total_cost) as t FROM (${resultFiltered.sql})`, resultFiltered.params);
    expect(Number(filteredRows[0]?.['t'])).toBeLessThan(Number(allRows[0]?.['t']));
  });

  it('queries missing tags', async () => {
    const result = buildMissingTagsQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_team'),
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);
    const firstRow = rows[0];
    expect(firstRow?.['service']).toBeDefined();
    expect(Number(firstRow?.['cost'])).toBeGreaterThanOrEqual(0);
  });

  it('classifies missing tags into actionable vs likely-untaggable buckets', async () => {
    const result = buildMissingTagsQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_team'),
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);

    // Every row carries a bucket and a tagged_ratio.
    for (const row of rows) {
      const bucket = String(row['bucket']);
      expect(['actionable', 'likely-untaggable']).toContain(bucket);
      const ratio = Number(row['tagged_ratio']);
      expect(ratio).toBeGreaterThanOrEqual(0);
      expect(ratio).toBeLessThanOrEqual(1);
      // Invariant: actionable iff ratio > 0.
      if (bucket === 'actionable') {
        expect(ratio).toBeGreaterThan(0);
      } else {
        expect(ratio).toBe(0);
      }
    }
  });

  it('non-resource cost query returns rows for non-Usage line items', async () => {
    const result = buildNonResourceCostQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_team'),
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    // Fixture may have zero non-Usage lines; just verify the query is valid
    // and every returned row has the expected shape.
    for (const row of rows) {
      expect(typeof row['service']).toBe('string');
      expect(typeof row['line_item_type']).toBe('string');
      expect(Number(row['cost'])).toBeGreaterThan(0);
    }
  });

  it('queries entity detail by service', async () => {
    const result = buildEntityDetailQuery(
      {
        entity: asEntityRef('AmazonRDS'),
        dimension: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-02-28') },
        filters: {},
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reads hourly raw files', async () => {
    const source = buildSource(SYNTHETIC_DIR, 'hourly', dimensions);
    const rows = await queryAll(conn, `SELECT COUNT(*) as cnt FROM ${source}`);
    expect(Number(rows[0]?.['cnt'])).toBeGreaterThan(0);
  });

  it('hourly tier exposes both usage_date (DATE) and usage_hour (TIMESTAMP)', async () => {
    const source = buildSource(SYNTHETIC_DIR, 'hourly', dimensions);
    const rows = await queryAll(conn, `
      SELECT typeof(usage_date) AS d_type, typeof(usage_hour) AS h_type
      FROM ${source} LIMIT 1
    `);
    expect(rows[0]?.['d_type']).toBe('DATE');
    expect(rows[0]?.['h_type']).toBe('TIMESTAMP');
  });

  it('cost query with hourly granularity returns rows for an end-day-inclusive range', async () => {
    // Regression: BETWEEN against a TIMESTAMP would truncate the end string to
    // midnight and silently drop most of the end day. With usage_date as DATE,
    // the same 'YYYY-MM-DD' end value covers the full day.
    const result = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') },
        filters: {},
        granularity: 'hourly',
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0]?.['total_cost'])).toBeGreaterThan(0);
  });

  it('hourly cost query returns the same total as a SUM over the raw hourly source', async () => {
    const range = { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') } as const;
    const result = buildCostQuery(
      { groupBy: asDimensionId('service'), dateRange: range, filters: {}, granularity: 'hourly' },
      SYNTHETIC_DIR,
      dimensions,
    );
    const queryTotalRows = await queryAllPrepared(conn, `SELECT SUM(total_cost) AS t FROM (${result.sql})`, result.params);
    const queryTotal = Number(queryTotalRows[0]?.['t'] ?? 0);

    const source = buildSource(SYNTHETIC_DIR, 'hourly', dimensions);
    const rawRows = await queryAll(conn, `
      SELECT SUM(cost) AS t FROM ${source}
      WHERE usage_date BETWEEN '${range.start}' AND '${range.end}'
    `);
    const rawTotal = Number(rawRows[0]?.['t'] ?? 0);

    expect(queryTotal).toBeGreaterThan(0);
    expect(queryTotal).toBeCloseTo(rawTotal, 2);
  });

  it('daily costs query with hourly granularity includes hour in date field', async () => {
    const result = buildDailyCostsQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') },
        filters: {},
        granularity: 'hourly',
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);

    const dates = [...new Set(rows.map(r => String(r['date'])))];
    const hasHourComponent = dates.some(d => d.includes(':'));
    expect(hasHourComponent).toBe(true);
    // Fixture only has daily timestamps at 00:00, but the date field should contain hour info
    expect(dates[0]).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:00/);
  });

  it('daily costs query with daily granularity returns daily data points', async () => {
    const result = buildDailyCostsQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        granularity: 'daily',
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAllPrepared(conn, result.sql, result.params);
    expect(rows.length).toBeGreaterThan(0);

    const dates = new Set(rows.map(r => String(r['date'])));
    const hasHourComponent = [...dates].some(d => d.includes(':'));
    expect(hasHourComponent).toBe(false);
    expect(dates.size).toBeLessThanOrEqual(31);
  });
});
