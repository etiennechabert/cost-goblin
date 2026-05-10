import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asDimensionId, buildSource } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import { parseCursor, encodeCursor, clampPageSize } from '../main/handlers/pagination-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNTHETIC_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'synthetic');

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

describe('Explorer pagination integration', () => {
  let db: Awaited<ReturnType<typeof DuckDBInstance.create>>;
  let conn: Awaited<ReturnType<typeof db.connect>>;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
  });

  afterAll(() => {
    // DuckDB Node API handles cleanup automatically
  });

  it('cursor encoding/decoding round-trip', () => {
    const offset = 500;
    const cursor = encodeCursor(offset);
    const decoded = parseCursor(cursor);
    expect(decoded).toBe(offset);
  });

  it('parseCursor returns 0 for undefined cursor', () => {
    expect(parseCursor(undefined)).toBe(0);
  });

  it('clampPageSize bounds page size to valid range', () => {
    expect(clampPageSize(0, 2000)).toBe(1);
    expect(clampPageSize(500, 2000)).toBe(500);
    expect(clampPageSize(3000, 2000)).toBe(2000);
    expect(clampPageSize(-100, 2000)).toBe(1);
    expect(clampPageSize(1500.7, 2000)).toBe(1500);
  });

  it('queries first page with LIMIT and no OFFSET', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });
    const pageSize = 50;

    const sql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id,
        service,
        CAST(cost AS DOUBLE) AS cost
      FROM ${source}
      ORDER BY usage_date DESC, cost DESC
      LIMIT ${String(pageSize)}
    `.trim();

    const rows = await queryAll(conn, sql);

    expect(rows.length).toBeLessThanOrEqual(pageSize);
    expect(rows.length).toBeGreaterThan(0);

    // Verify rows are sorted correctly
    if (rows.length > 1) {
      const first = rows[0];
      const second = rows[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      // Dates should be descending or equal, then cost descending
      const date1 = String(first?.['usage_date']);
      const date2 = String(second?.['usage_date']);
      if (date1 === date2) {
        expect(Number(first?.['cost'])).toBeGreaterThanOrEqual(Number(second?.['cost']));
      } else {
        // Compare date strings lexicographically (works for ISO format YYYY-MM-DD)
        expect(date1 >= date2).toBe(true);
      }
    }
  });

  it('queries second page with OFFSET using cursor', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });
    const pageSize = 50;
    const offset = 50;
    const cursor = encodeCursor(offset);
    const decodedOffset = parseCursor(cursor);

    expect(decodedOffset).toBe(offset);

    const sql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id,
        service,
        CAST(cost AS DOUBLE) AS cost
      FROM ${source}
      ORDER BY usage_date DESC, cost DESC
      LIMIT ${String(pageSize)}
      OFFSET ${String(decodedOffset)}
    `.trim();

    const rows = await queryAll(conn, sql);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(pageSize);
  });

  it('total count query matches paginated results count', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });

    // Get total count
    const countSql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${source}`;
    const countRows = await queryAll(conn, countSql);
    const totalRows = Number(countRows[0]?.['n']);

    expect(totalRows).toBeGreaterThan(0);

    // Fetch pages until we have all rows
    const pageSize = 100;
    let offset = 0;
    let accumulatedRows = 0;
    let hasMore = true;
    let pageCount = 0;
    const maxPages = 50; // Safety limit to prevent infinite loops

    while (hasMore && pageCount < maxPages) {
      const sql = `
        SELECT
          usage_date::VARCHAR AS usage_date,
          account_id,
          service,
          CAST(cost AS DOUBLE) AS cost
        FROM ${source}
        ORDER BY usage_date DESC, cost DESC
        LIMIT ${String(pageSize)}
        OFFSET ${String(offset)}
      `.trim();

      const rows = await queryAll(conn, sql);
      accumulatedRows += rows.length;

      hasMore = (offset + pageSize) < totalRows;
      offset += pageSize;
      pageCount += 1;

      // On the last page, rows.length should be less than pageSize or exactly pageSize
      if (!hasMore) {
        expect(rows.length).toBeLessThanOrEqual(pageSize);
        expect(accumulatedRows).toBe(totalRows);
      }
    }

    expect(accumulatedRows).toBe(totalRows);
  });

  it('hasMore flag is false on last page', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });

    // Get total count
    const countSql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${source}`;
    const countRows = await queryAll(conn, countSql);
    const totalRows = Number(countRows[0]?.['n']);

    const pageSize = 100;

    // Calculate offset for last page
    const lastPageOffset = Math.floor(totalRows / pageSize) * pageSize;

    // Query last page
    const sql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id,
        service,
        CAST(cost AS DOUBLE) AS cost
      FROM ${source}
      ORDER BY usage_date DESC, cost DESC
      LIMIT ${String(pageSize)}
      OFFSET ${String(lastPageOffset)}
    `.trim();

    const rows = await queryAll(conn, sql);

    // Calculate hasMore based on handler logic
    const hasMore = (lastPageOffset + pageSize) < totalRows;

    expect(hasMore).toBe(false);
    expect(rows.length).toBe(totalRows - lastPageOffset);
  });

  it('hasMore flag is true when more pages exist', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });

    // Get total count
    const countSql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${source}`;
    const countRows = await queryAll(conn, countSql);
    const totalRows = Number(countRows[0]?.['n']);

    expect(totalRows).toBeGreaterThan(100); // Ensure we have enough data

    const pageSize = 50;
    const offset = 0;

    // Query first page
    const sql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id,
        service,
        CAST(cost AS DOUBLE) AS cost
      FROM ${source}
      ORDER BY usage_date DESC, cost DESC
      LIMIT ${String(pageSize)}
      OFFSET ${String(offset)}
    `.trim();

    const rows = await queryAll(conn, sql);

    // Calculate hasMore based on handler logic
    const hasMore = (offset + pageSize) < totalRows;

    expect(hasMore).toBe(true);
    expect(rows.length).toBe(pageSize);
  });

  it('cursor encodes next page offset correctly', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });
    const pageSize = 50;

    // Get total count
    const countSql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${source}`;
    const countRows = await queryAll(conn, countSql);
    const totalRows = Number(countRows[0]?.['n']);

    // Simulate first page request
    const offset1 = 0;
    const hasMore1 = (offset1 + pageSize) < totalRows;
    const nextCursor1 = hasMore1 ? encodeCursor(offset1 + pageSize) : undefined;

    expect(hasMore1).toBe(true);
    expect(nextCursor1).toBeDefined();

    // Decode cursor for second page
    const offset2 = parseCursor(nextCursor1);
    expect(offset2).toBe(pageSize);

    const hasMore2 = (offset2 + pageSize) < totalRows;
    const nextCursor2 = hasMore2 ? encodeCursor(offset2 + pageSize) : undefined;

    // If there's a third page
    if (hasMore2) {
      expect(nextCursor2).toBeDefined();
      const offset3 = parseCursor(nextCursor2);
      expect(offset3).toBe(pageSize * 2);
    }
  });

  it('pagination works with filters applied', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });
    const pageSize = 20;
    const filter = "WHERE service = 'AmazonEC2'";

    // Get total count with filter
    const countSql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${source} ${filter}`;
    const countRows = await queryAll(conn, countSql);
    const totalRows = Number(countRows[0]?.['n']);

    if (totalRows === 0) {
      // Skip test if no EC2 data in fixtures
      return;
    }

    // Query first page with filter
    const sql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id,
        service,
        CAST(cost AS DOUBLE) AS cost
      FROM ${source}
      ${filter}
      ORDER BY usage_date DESC, cost DESC
      LIMIT ${String(pageSize)}
    `.trim();

    const rows = await queryAll(conn, sql);

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(Math.min(pageSize, totalRows));

    // Verify all rows match filter
    for (const row of rows) {
      expect(row['service']).toBe('AmazonEC2');
    }

    const hasMore = (0 + pageSize) < totalRows;
    if (hasMore) {
      expect(totalRows).toBeGreaterThan(pageSize);
    }
  });

  it('empty result set returns correct pagination metadata', async () => {
    const source = buildSource({ dataDir: SYNTHETIC_DIR, tier: 'daily', dimensions });
    const pageSize = 100;
    const filter = "WHERE service = 'NonExistentService12345'";

    // Get total count with impossible filter
    const countSql = `SELECT CAST(COUNT(*) AS DOUBLE) AS n FROM ${source} ${filter}`;
    const countRows = await queryAll(conn, countSql);
    const totalRows = Number(countRows[0]?.['n']);

    expect(totalRows).toBe(0);

    // Query first page with filter
    const sql = `
      SELECT
        usage_date::VARCHAR AS usage_date,
        account_id,
        service,
        CAST(cost AS DOUBLE) AS cost
      FROM ${source}
      ${filter}
      ORDER BY usage_date DESC, cost DESC
      LIMIT ${String(pageSize)}
    `.trim();

    const rows = await queryAll(conn, sql);

    expect(rows.length).toBe(0);

    const hasMore = (0 + pageSize) < totalRows;
    expect(hasMore).toBe(false);
  });
});
