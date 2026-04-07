import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCostQuery, buildMissingTagsQuery, buildEntityDetailQuery } from '../query/builder.js';
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
    const rows = await queryAll(conn, `SELECT COUNT(*) as cnt FROM read_parquet('${SYNTHETIC_DIR}/aws/daily/**/data.parquet', hive_partitioning = true)`);
    expect(Number(rows[0]?.['cnt'])).toBeGreaterThan(0);
  });

  it('queries costs grouped by service', async () => {
    const sql = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAll(conn, sql);
    expect(rows.length).toBeGreaterThan(0);
    const firstRow = rows[0];
    expect(firstRow?.['entity']).toBeDefined();
    expect(firstRow?.['total_cost']).toBeDefined();
  });

  it('queries costs with filter', async () => {
    const sqlAll = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const sqlFiltered = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: { [asDimensionId('region')]: asTagValue('eu-central-1') },
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const allRows = await queryAll(conn, `SELECT SUM(total_cost) as t FROM (${sqlAll})`);
    const filteredRows = await queryAll(conn, `SELECT SUM(total_cost) as t FROM (${sqlFiltered})`);
    expect(Number(filteredRows[0]?.['t'])).toBeLessThan(Number(allRows[0]?.['t']));
  });

  it('queries missing tags', async () => {
    const sql = buildMissingTagsQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_team'),
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAll(conn, sql);
    expect(rows.length).toBeGreaterThan(0);
    const firstRow = rows[0];
    expect(firstRow?.['service']).toBeDefined();
    expect(Number(firstRow?.['cost'])).toBeGreaterThanOrEqual(0);
  });

  it('queries entity detail by service', async () => {
    const sql = buildEntityDetailQuery(
      {
        entity: asEntityRef('AmazonRDS'),
        dimension: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-02-28') },
        filters: {},
      },
      SYNTHETIC_DIR,
      dimensions,
    );
    const rows = await queryAll(conn, sql);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reads hourly partitions', async () => {
    const rows = await queryAll(conn, `SELECT COUNT(*) as cnt FROM read_parquet('${SYNTHETIC_DIR}/aws/hourly/**/data.parquet', hive_partitioning = true)`);
    expect(Number(rows[0]?.['cnt'])).toBeGreaterThan(0);
  });
});
