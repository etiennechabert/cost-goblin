import { describe, expect, it } from 'vitest';
import { tagSqlColumn, tagSqlColumnsById } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import {
  aggregatedOrderBy,
  appendRowFilters,
  explorerGroupBy,
  explorerOrderBy,
  explorerSqlColumn,
  groupByExpressions,
  groupBySelectList,
  groupByValues,
} from '../main/handlers/explorer-columns.js';

const dims: DimensionsConfig = {
  builtIn: [],
  tags: [
    { tagName: 'STAGE', label: 'STAGE' },
    { tagName: 'stage', label: 'stage' },
  ],
};
const columns = tagSqlColumnsById(dims.tags);
const UPPER = tagSqlColumn({ tagName: 'STAGE' });
const LOWER = tagSqlColumn({ tagName: 'stage' });

describe('explorerSqlColumn', () => {
  it('passes scalar columns through and maps tag ids to their SQL column', () => {
    expect(explorerSqlColumn('service', columns)).toBe('service');
    expect(explorerSqlColumn('usage_date', columns)).toBe('usage_date');
    expect(explorerSqlColumn('tag_stage', columns)).toBe(LOWER);
  });

  it('rejects ids outside the allow-list', () => {
    expect(explorerSqlColumn('tag_unknown', columns)).toBeNull();
    expect(explorerSqlColumn('service; DROP TABLE x', columns)).toBeNull();
    // An SQL column name is not an id: the renderer must not address it directly.
    expect(explorerSqlColumn(LOWER, columns)).toBeNull();
  });
});

describe('explorerOrderBy', () => {
  it('orders by the tag column behind the id', () => {
    expect(explorerOrderBy({ column: 'tag_STAGE', direction: 'asc' }, columns)).toBe(`${UPPER} ASC`);
    expect(explorerOrderBy({ column: 'tag_stage', direction: 'desc' }, columns)).toBe(`${LOWER} DESC`);
  });

  it('falls back to |cost| for no sort or an unknown column', () => {
    expect(explorerOrderBy(undefined, columns)).toBe('ABS(cost) DESC');
    expect(explorerOrderBy({ column: 'nope', direction: 'asc' }, columns)).toBe('ABS(cost) DESC');
  });
});

describe('appendRowFilters', () => {
  it('filters each tag on its own column, quote-escaping the value', () => {
    expect(appendRowFilters('', { tag_STAGE: 'PROD', tag_stage: "o'dev" }, columns))
      .toBe(`WHERE ${UPPER} = 'PROD' AND ${LOWER} = 'o''dev'`);
  });

  it('extends an existing WHERE, casts usage_date, and drops empty or unknown filters', () => {
    expect(appendRowFilters('WHERE x = 1', { usage_date: '2026-01-05', tag_unknown: 'a', service: '' }, columns))
      .toBe("WHERE x = 1 AND usage_date::VARCHAR = '2026-01-05'");
    expect(appendRowFilters('WHERE x = 1', { service: '' }, columns)).toBe('WHERE x = 1');
    expect(appendRowFilters('WHERE x = 1', undefined, columns)).toBe('WHERE x = 1');
  });

  it('compares a monthly or weekly usage_date against its bucket, so a drill-down returns the whole period', () => {
    expect(appendRowFilters('', { usage_date: '2026-10-01' }, columns, 'monthly'))
      .toBe("WHERE CAST(date_trunc('month', usage_date) AS DATE)::VARCHAR = '2026-10-01'");
    expect(appendRowFilters('', { usage_date: '2026-10-12' }, columns, 'weekly'))
      .toBe("WHERE CAST(date_trunc('week', usage_date) AS DATE)::VARCHAR = '2026-10-12'");
  });

  it('leaves usage_date and the tag filters alone on daily and hourly', () => {
    for (const granularity of ['daily', 'hourly'] as const) {
      expect(appendRowFilters('', { usage_date: '2026-01-05' }, columns, granularity))
        .toBe("WHERE usage_date::VARCHAR = '2026-01-05'");
    }
    expect(appendRowFilters('', { tag_STAGE: 'PROD' }, columns, 'monthly')).toBe(`WHERE ${UPPER} = 'PROD'`);
  });
});

describe('aggregated table helpers', () => {
  const groupBy = explorerGroupBy(['usage_date', 'tag_STAGE', 'tag_unknown', 'tag_stage'], columns);

  it('keeps the resolvable ids in order, each with its own column', () => {
    expect(groupBy).toEqual([
      { id: 'usage_date', column: 'usage_date' },
      { id: 'tag_STAGE', column: UPPER },
      { id: 'tag_stage', column: LOWER },
    ]);
    expect(groupBySelectList(groupBy)).toBe(`usage_date::VARCHAR AS usage_date, ${UPPER}, ${LOWER}`);
  });

  it('groups usage_date by its week or month bucket, still read back under usage_date', () => {
    const monthly = explorerGroupBy(['usage_date', 'tag_STAGE'], columns, 'monthly');
    const bucket = "CAST(date_trunc('month', usage_date) AS DATE)";
    expect(groupBySelectList(monthly)).toBe(`${bucket}::VARCHAR AS usage_date, ${UPPER}`);
    expect(groupByExpressions(monthly)).toEqual([bucket, UPPER]);
    expect(groupByValues({ usage_date: '2026-10-01', [UPPER]: 'PROD' }, monthly))
      .toEqual({ usage_date: '2026-10-01', tag_STAGE: 'PROD' });
    expect(aggregatedOrderBy({ column: 'usage_date', direction: 'asc' }, monthly)).toBe(`${bucket} ASC`);
    expect(groupBySelectList(explorerGroupBy(['usage_date'], columns, 'weekly')))
      .toBe("CAST(date_trunc('week', usage_date) AS DATE)::VARCHAR AS usage_date");
  });

  it('keeps the daily output byte for byte, with or without a granularity', () => {
    for (const granularity of [undefined, 'daily', 'hourly'] as const) {
      const daily = explorerGroupBy(['usage_date', 'tag_STAGE'], columns, granularity);
      expect(daily).toEqual([{ id: 'usage_date', column: 'usage_date' }, { id: 'tag_STAGE', column: UPPER }]);
      expect(groupBySelectList(daily)).toBe(`usage_date::VARCHAR AS usage_date, ${UPPER}`);
      expect(groupByExpressions(daily)).toEqual(['usage_date', UPPER]);
    }
  });

  it('reads each value from its column back under the id', () => {
    expect(groupByValues({ usage_date: '2026-01-05', [UPPER]: 'PROD', [LOWER]: 'dev' }, groupBy))
      .toEqual({ usage_date: '2026-01-05', tag_STAGE: 'PROD', tag_stage: 'dev' });
  });

  it('sorts by a measure, then by a grouped column, else by SUM(cost)', () => {
    expect(aggregatedOrderBy({ column: 'row_count', direction: 'asc' }, groupBy)).toBe('COUNT(*) ASC');
    expect(aggregatedOrderBy({ column: 'abs_cost', direction: 'desc' }, groupBy)).toBe('ABS(SUM(cost)) DESC');
    expect(aggregatedOrderBy({ column: 'tag_stage', direction: 'desc' }, groupBy)).toBe(`${LOWER} DESC`);
    expect(aggregatedOrderBy({ column: 'region', direction: 'asc' }, groupBy)).toBe('SUM(cost) DESC');
    expect(aggregatedOrderBy(undefined, groupBy)).toBe('SUM(cost) DESC');
  });

  it('never reads a sort column off the prototype', () => {
    expect(aggregatedOrderBy({ column: 'constructor', direction: 'asc' }, groupBy)).toBe('SUM(cost) DESC');
  });
});
