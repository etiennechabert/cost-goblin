import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';
import { asDimensionId, tagDimColumn, tagSqlColumn } from '@costgoblin/core';
import type { DimensionsConfig, ExplorerFilterMap, TagDimension } from '@costgoblin/core';
import { buildExplorerFilterPredicate } from '../main/handlers/explorer-filters.js';
import { fetchRows } from './helpers/duckdb-rows.js';

const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
const TEAM_ID = tagDimColumn(TEAM);
const dimensions: DimensionsConfig = {
  builtIn: [{ name: asDimensionId('region'), label: 'Region', field: 'region' }],
  tags: [TEAM],
};

describe('buildExplorerFilterPredicate against DuckDB', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    // One power of two per line item, so every total names its items. A tag
    // the resource lacks is NULL; a built-in field is never NULL.
    await conn.run(`
      CREATE TABLE line_items AS SELECT * FROM (VALUES
        ('eu-west-1', 'web', 1.0),
        ('eu-west-1', NULL, 2.0),
        ('eu-west-1', '', 4.0),
        ('', 'web', 8.0)
      ) AS t(region, ${tagSqlColumn(TEAM)}, cost)
    `);
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  async function kept(filters: ExplorerFilterMap): Promise<number> {
    const predicate = buildExplorerFilterPredicate(filters, dimensions, new Map());
    const where = predicate === null ? '' : `WHERE ${predicate}`;
    const [r] = await fetchRows(conn, `SELECT COALESCE(SUM(cost), 0)::DOUBLE AS total FROM line_items ${where}`);
    return Number(r?.['total']);
  }

  it("keeps the line items with no value for '': a tag they lack, or an empty one", async () => {
    expect(await kept({ [TEAM_ID]: [''] })).toBe(6);
    expect(await kept({ [TEAM_ID]: ['web', ''] })).toBe(15);
    expect(await kept({ region: [''] })).toBe(8);
  });

  it('keeps only the matching line items for a value, across filters', async () => {
    expect(await kept({ [TEAM_ID]: ['web'] })).toBe(9);
    expect(await kept({ [TEAM_ID]: ['web'], region: ['eu-west-1'] })).toBe(1);
  });

  // An Explorer column can have no configured dimension (SKU Meter in a
  // GCP-only workspace). Its filter is left out, where an exclusion rule's
  // condition would match nothing.
  it('leaves out a filter on a column with no configured dimension', async () => {
    expect(await kept({ [TEAM_ID]: ['web'], sku_meter: ['77F2-CE67-FC93'] })).toBe(9);
  });

  it('adds nothing without a filter value', () => {
    expect(buildExplorerFilterPredicate({}, dimensions, new Map())).toBeNull();
    expect(buildExplorerFilterPredicate({ [TEAM_ID]: [] }, dimensions, new Map())).toBeNull();
  });
});
