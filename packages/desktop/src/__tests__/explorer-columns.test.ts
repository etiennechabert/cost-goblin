import { describe, expect, it } from 'vitest';
import { QueryBuilder, tagSqlColumn, tagSqlColumnsById } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import {
  aggregatedOrderBy,
  explorerGroupBy,
  explorerOrderBy,
  explorerRowFilters,
  explorerSqlColumn,
  groupByList,
  groupBySelectList,
  groupByValues,
  groupValueExpr,
  rowFilterConditions,
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
/** A column as a group-by row reads it. */
const text = (column: string): string => `COALESCE(CAST(${column} AS VARCHAR), '')`;
const MONTH = "CAST(date_trunc('month', usage_date) AS DATE)";
const WEEK = "CAST(date_trunc('week', usage_date) AS DATE)";

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

describe('explorerRowFilters', () => {
  it('resolves each tag id to its own column', () => {
    expect(explorerRowFilters({ tag_STAGE: 'PROD', tag_stage: "o'dev" }, columns)).toEqual([
      { column: UPPER, value: 'PROD' },
      { column: LOWER, value: "o'dev" },
    ]);
  });

  it('drops ids outside the allow-list, and keeps an empty value', () => {
    expect(explorerRowFilters({ usage_date: '2026-01-05', tag_unknown: 'a', service: '', [LOWER]: 'dev' }, columns))
      .toEqual([{ column: 'usage_date', value: '2026-01-05' }, { column: 'service', value: '' }]);
    expect(explorerRowFilters(undefined, columns)).toEqual([]);
  });

  it('holds a weekly or monthly usage_date to its bucket, and leaves daily, hourly and tags alone', () => {
    expect(explorerRowFilters({ usage_date: '2026-10-01' }, columns, 'monthly')).toEqual([{ column: 'usage_date', bucket: MONTH, value: '2026-10-01' }]);
    expect(explorerRowFilters({ usage_date: '2026-10-12' }, columns, 'weekly')).toEqual([{ column: 'usage_date', bucket: WEEK, value: '2026-10-12' }]);
    for (const granularity of [undefined, 'daily', 'hourly'] as const) {
      expect(explorerRowFilters({ usage_date: '2026-01-05' }, columns, granularity)).toEqual([{ column: 'usage_date', value: '2026-01-05' }]);
    }
    expect(explorerRowFilters({ tag_STAGE: 'PROD' }, columns, 'monthly')).toEqual([{ column: UPPER, value: 'PROD' }]);
  });
});

describe('rowFilterConditions', () => {
  it('binds each value through the builder, never into the SQL', () => {
    const qb = new QueryBuilder();
    expect(rowFilterConditions(explorerRowFilters({ tag_STAGE: 'PROD', tag_stage: "o'dev" }, columns), qb))
      .toEqual([`${text(UPPER)} = $1`, `${text(LOWER)} = $2`]);
    expect(qb.build().params).toEqual(['PROD', "o'dev"]);
  });

  it('compares each column as its group-by row reads it, numbering on from the builder', () => {
    const qb = new QueryBuilder();
    qb.addParam('earlier');
    expect(rowFilterConditions([{ column: 'usage_date', value: '2026-01-05' }, { column: LOWER, value: '' }], qb))
      .toEqual([`${text('usage_date')} = $2`, `${text(LOWER)} = $3`]);
    expect(qb.build().params).toEqual(['earlier', '2026-01-05', '']);
  });

  it('adds nothing without filters', () => {
    const qb = new QueryBuilder();
    expect(rowFilterConditions([], qb)).toEqual([]);
    expect(qb.build().params).toEqual([]);
  });

  it('compares a monthly or weekly usage_date against its bucket, so a drill-down returns the whole period', () => {
    const qb = new QueryBuilder();
    const filters = [
      ...explorerRowFilters({ usage_date: '2026-10-01' }, columns, 'monthly'),
      ...explorerRowFilters({ usage_date: '2026-10-12' }, columns, 'weekly'),
    ];
    expect(rowFilterConditions(filters, qb)).toEqual([`${text(MONTH)} = $1`, `${text(WEEK)} = $2`]);
    expect(qb.build().params).toEqual(['2026-10-01', '2026-10-12']);
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
  });

  it('reads a group as text that is never NULL, a bucketed date as its bucket', () => {
    expect(groupValueExpr({ column: 'usage_hour' })).toBe(text('usage_hour'));
    expect(groupValueExpr({ column: 'usage_date', bucket: MONTH })).toBe(text(MONTH));
  });

  it('selects each group as its text under its column, and groups on that text', () => {
    expect(groupBySelectList(groupBy)).toBe(`${text('usage_date')} AS usage_date, ${text(UPPER)} AS ${UPPER}, ${text(LOWER)} AS ${LOWER}`);
    // A date's text is never '' and differs per date, so grouping on the
    // date itself splits the line items the same way, without a cast each.
    expect(groupByList(groupBy)).toBe(`usage_date, ${text(UPPER)}, ${text(LOWER)}`);
  });

  it('groups usage_date by its week or month bucket, still read back under usage_date', () => {
    const monthly = explorerGroupBy(['usage_date', 'tag_STAGE'], columns, 'monthly');
    expect(groupBySelectList(monthly)).toBe(`${text(MONTH)} AS usage_date, ${text(UPPER)} AS ${UPPER}`);
    // The bucket is a date too: it groups and sorts on itself.
    expect(groupByList(monthly)).toBe(`${MONTH}, ${text(UPPER)}`);
    expect(groupByValues({ usage_date: '2026-10-01', [UPPER]: 'PROD' }, monthly))
      .toEqual({ usage_date: '2026-10-01', tag_STAGE: 'PROD' });
    expect(aggregatedOrderBy({ column: 'usage_date', direction: 'asc' }, monthly)).toBe(`${MONTH} ASC`);
    expect(groupBySelectList(explorerGroupBy(['usage_date'], columns, 'weekly'))).toBe(`${text(WEEK)} AS usage_date`);
  });

  it('keeps the daily output byte for byte, with or without a granularity', () => {
    for (const granularity of [undefined, 'daily', 'hourly'] as const) {
      const daily = explorerGroupBy(['usage_date', 'tag_STAGE'], columns, granularity);
      expect(daily).toEqual([{ id: 'usage_date', column: 'usage_date' }, { id: 'tag_STAGE', column: UPPER }]);
      expect(groupBySelectList(daily)).toBe(`${text('usage_date')} AS usage_date, ${text(UPPER)} AS ${UPPER}`);
      expect(groupByList(daily)).toBe(`usage_date, ${text(UPPER)}`);
    }
  });

  it('reads each value from its column back under the id', () => {
    expect(groupByValues({ usage_date: '2026-01-05', [UPPER]: 'PROD', [LOWER]: 'dev' }, groupBy))
      .toEqual({ usage_date: '2026-01-05', tag_STAGE: 'PROD', tag_stage: 'dev' });
  });

  it('sorts by a measure, then by a grouped column, else by SUM(cost)', () => {
    expect(aggregatedOrderBy({ column: 'row_count', direction: 'asc' }, groupBy)).toBe('COUNT(*) ASC');
    expect(aggregatedOrderBy({ column: 'abs_cost', direction: 'desc' }, groupBy)).toBe('ABS(SUM(cost)) DESC');
    expect(aggregatedOrderBy({ column: 'tag_stage', direction: 'desc' }, groupBy)).toBe(`${text(LOWER)} DESC`);
    expect(aggregatedOrderBy({ column: 'usage_date', direction: 'asc' }, groupBy)).toBe('usage_date ASC');
    expect(aggregatedOrderBy({ column: 'region', direction: 'asc' }, groupBy)).toBe('SUM(cost) DESC');
    expect(aggregatedOrderBy(undefined, groupBy)).toBe('SUM(cost) DESC');
  });

  it('never reads a sort column off the prototype', () => {
    expect(aggregatedOrderBy({ column: 'constructor', direction: 'asc' }, groupBy)).toBe('SUM(cost) DESC');
  });
});
