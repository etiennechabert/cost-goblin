import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { asDimensionId, type DimensionsConfig, type ExclusionRule } from '@costgoblin/core';
import { appendRowFilters, buildExplorerWhere, resolveAggregatedSort, type ExplorerWhereInput } from '../main/handlers/explorer-sql.js';
import { fetchRowsPrepared } from './helpers/duckdb-rows.js';

// #479: the Explorer built its WHERE by hand — dates interpolated, row-filter
// values hand-escaped into `col = '...'`, exclusion values inlined. Every
// value now binds as a $n parameter.

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
  ],
  tags: [{ tagName: 'team', label: 'Team' }],
};

const noAccounts = new Map<string, readonly string[]>();

function input(over: Partial<ExplorerWhereInput> = {}): ExplorerWhereInput {
  return {
    startStr: '2026-05-01',
    endStr: '2026-05-31',
    tier: 'daily',
    filters: {},
    dimensions,
    accountReverseMap: noAccounts,
    ...over,
  };
}

const QUOTED = "o'brien";

const quotedTeamRule: ExclusionRule = {
  id: 'quoted', name: 'quoted', enabled: true, builtIn: false,
  conditions: [{ dimensionId: asDimensionId('tag_team'), values: [QUOTED] }],
};

describe('buildExplorerWhere', () => {
  it('binds the day bounds', () => {
    const where = buildExplorerWhere(input());
    expect(where.sql).toBe('WHERE usage_date BETWEEN $1 AND $2');
    expect(where.params).toEqual(['2026-05-01', '2026-05-31']);
  });

  it('binds hour bounds on the hourly tier only', () => {
    const hours = { startHour: '2026-05-02 03:00:00', endHour: '2026-05-02 09:00:00' };
    const hourly = buildExplorerWhere(input({ ...hours, tier: 'hourly' }));
    expect(hourly.sql).toBe('WHERE usage_hour BETWEEN $1::TIMESTAMP AND $2::TIMESTAMP');
    expect(hourly.params).toEqual([hours.startHour, hours.endHour]);
    // usage_hour only exists on the hourly tier.
    expect(buildExplorerWhere(input({ ...hours, tier: 'daily' })).sql).toBe('WHERE usage_date BETWEEN $1 AND $2');
  });

  it('binds filter and exclusion values instead of inlining them', () => {
    const where = buildExplorerWhere(input({
      filters: { tag_team: [QUOTED], service: ['EC2'] },
      exclusionRules: [quotedTeamRule],
    }));
    expect(where.sql).not.toContain('brien');
    expect(where.sql).not.toContain('EC2');
    expect(where.params).toContain(QUOTED);
    expect(where.params).toContain('EC2');
    // One placeholder per bound value, numbered in order.
    expect(where.sql).toMatch(/\$5\b/);
    expect(where.sql).not.toMatch(/\$6\b/);
    expect(where.params).toHaveLength(5);
  });

  it('expands an account display-name filter to its ids', () => {
    const where = buildExplorerWhere(input({
      filters: { account: ['prod'] },
      accountReverseMap: new Map([['prod', ['111', '112']]]),
    }));
    expect(where.params).toEqual(['2026-05-01', '2026-05-31', '111', '112']);
    expect(where.sql).not.toContain('prod');
  });

  it('ignores a filter on a dimension the config no longer has, keeping the others', () => {
    // A restored filter can name a removed tag. It must neither drop the other
    // filters nor leave an unused bound value (which fails the query).
    const where = buildExplorerWhere(input({ filters: { tag_removed: ['x'], service: ['EC2'] } }));
    expect(where.params).toEqual(['2026-05-01', '2026-05-31', 'EC2']);
    expect(where.sql).toContain('COALESCE(service IN ($3), FALSE)');
    expect(where.sql).not.toContain('tag_removed');
  });

  it('drops an exclusion rule with a condition on a removed dimension without binding its values', () => {
    const dangling: ExclusionRule = {
      id: 'dangling', name: 'dangling', enabled: true, builtIn: false,
      conditions: [
        { dimensionId: asDimensionId('service'), values: ['EC2'] },
        { dimensionId: asDimensionId('tag_removed'), values: ['x'] },
      ],
    };
    const where = buildExplorerWhere(input({ exclusionRules: [dangling] }));
    expect(where.sql).toBe('WHERE usage_date BETWEEN $1 AND $2');
    expect(where.params).toEqual(['2026-05-01', '2026-05-31']);
  });
});

describe('appendRowFilters', () => {
  const tagIds = new Set(['tag_team']);

  it('continues the base numbering and binds each value', () => {
    const base = buildExplorerWhere(input());
    const where = appendRowFilters(base, { tag_team: QUOTED, usage_date: '2026-05-02' }, tagIds);
    expect(where.sql).toBe('WHERE usage_date BETWEEN $1 AND $2 AND tag_team = $3 AND usage_date::VARCHAR = $4');
    expect(where.params).toEqual(['2026-05-01', '2026-05-31', QUOTED, '2026-05-02']);
    expect(base.params).toHaveLength(2); // the shared WHERE is untouched
  });

  it('ignores unknown columns and empty values', () => {
    const base = buildExplorerWhere(input());
    expect(appendRowFilters(base, { 'x; DROP TABLE t': 'v', service: '' }, tagIds)).toEqual(base);
    expect(appendRowFilters(base, undefined, tagIds)).toEqual(base);
  });
});

describe('resolveAggregatedSort', () => {
  it('sorts by a metric aggregate or an allow-listed group-by column', () => {
    expect(resolveAggregatedSort(undefined, [])).toBe('SUM(cost) DESC');
    expect(resolveAggregatedSort({ column: 'row_count', direction: 'asc' }, [])).toBe('COUNT(*) ASC');
    expect(resolveAggregatedSort({ column: 'list_cost', direction: 'desc' }, [])).toBe('SUM(list_cost) DESC');
    expect(resolveAggregatedSort({ column: 'usage_amount', direction: 'asc' }, [])).toBe('SUM(usage_amount) ASC');
    expect(resolveAggregatedSort({ column: 'service', direction: 'desc' }, ['service'])).toBe('service DESC');
    expect(resolveAggregatedSort({ column: 'service', direction: 'desc' }, [])).toBe('SUM(cost) DESC');
  });

  it.each(['constructor', 'toString', 'valueOf', 'isPrototypeOf', '__proto__'])(
    'falls back to the default for the Object.prototype key %s',
    (column) => {
      expect(resolveAggregatedSort({ column, direction: 'asc' }, [])).toBe('SUM(cost) DESC');
    },
  );
});

describe('Explorer WHERE against DuckDB', () => {
  let db: DuckDBInstance;
  let conn: DuckDBConnection;

  beforeAll(async () => {
    db = await DuckDBInstance.create();
    conn = await db.connect();
    // The columns buildSource projects that the Explorer WHERE references.
    await conn.run(`
      CREATE TABLE src AS SELECT * FROM (VALUES
        (DATE '2026-05-02', TIMESTAMP '2026-05-02 04:00:00', '111', 'EC2', 'o''brien', 1.0),
        (DATE '2026-05-02', TIMESTAMP '2026-05-02 10:00:00', '111', 'EC2', 'platform', 2.0),
        (DATE '2026-05-03', TIMESTAMP '2026-05-03 04:00:00', '222', 'S3', NULL, 4.0),
        (DATE '2026-06-01', TIMESTAMP '2026-06-01 04:00:00', '222', 'S3', NULL, 8.0)
      ) AS t(usage_date, usage_hour, account_id, service, tag_team, cost)
    `);
  });

  afterAll(() => {
    conn.disconnectSync();
    db.closeSync();
  });

  async function total(where: { sql: string; params: readonly unknown[] }): Promise<number> {
    const rows = await fetchRowsPrepared(conn, `SELECT COALESCE(SUM(cost), 0) AS c FROM src ${where.sql}`, where.params);
    return Number(rows[0]?.['c']);
  }

  it('applies the date window, filters, exclusions and row filters through bound values', async () => {
    expect(await total(buildExplorerWhere(input()))).toBe(7);
    expect(await total(buildExplorerWhere(input({ filters: { tag_team: [QUOTED] } })))).toBe(1);
    // NULL-safe exclusion: the untagged S3 row stays.
    expect(await total(buildExplorerWhere(input({ exclusionRules: [quotedTeamRule] })))).toBe(6);
    const base = buildExplorerWhere(input());
    expect(await total(appendRowFilters(base, { tag_team: QUOTED }, new Set(['tag_team'])))).toBe(1);
    expect(await total(appendRowFilters(base, { usage_date: '2026-05-03' }, new Set()))).toBe(4);
  });

  it('applies hour bounds on the hourly tier', async () => {
    const where = buildExplorerWhere(input({ tier: 'hourly', startHour: '2026-05-02 00:00:00', endHour: '2026-05-02 06:00:00' }));
    expect(await total(where)).toBe(1);
  });
});
