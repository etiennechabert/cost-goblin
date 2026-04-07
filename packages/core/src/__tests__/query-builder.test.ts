import { describe, it, expect } from 'vitest';
import { buildCostQuery, buildTrendQuery, buildMissingTagsQuery, buildEntityDetailQuery } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asDateString, asDollars, asEntityRef, asTagValue } from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [
    {
      tagName: 'org:team',
      label: 'Team',
      concept: 'owner',
      normalize: 'lowercase-kebab',
      aliases: {
        'core-banking': ['core_banking', 'corebanking'],
      },
    },
  ],
};

describe('buildCostQuery', () => {
  it('generates valid SQL for built-in dimension', () => {
    const sql = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain('service AS entity');
    expect(sql).toContain("usage_date BETWEEN '2026-01-01' AND '2026-01-31'");
    expect(sql).toContain('read_parquet');
  });

  it('includes filter clauses', () => {
    const sql = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: { [asDimensionId('account')]: asTagValue('111111111111') },
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain("account_id = '111111111111'");
  });

  it('uses alias SQL for tag dimensions', () => {
    const sql = buildCostQuery(
      {
        groupBy: asDimensionId('tag_org_team'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain('CASE');
    expect(sql).toContain("'core-banking'");
  });
});

describe('buildTrendQuery', () => {
  it('generates SQL with period comparison', () => {
    const sql = buildTrendQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') },
        filters: {},
        deltaThreshold: asDollars(100),
        percentThreshold: 10,
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain('current_period');
    expect(sql).toContain('previous_period');
    expect(sql).toContain('delta');
    expect(sql).toContain('100');
  });
});

describe('buildMissingTagsQuery', () => {
  it('filters on NULL or empty tag', () => {
    const sql = buildMissingTagsQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(50),
        tagDimension: asDimensionId('tag_org_team'),
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain('IS NULL');
    expect(sql).toContain("= ''");
    expect(sql).toContain('50');
  });
});

describe('buildEntityDetailQuery', () => {
  it('generates detail query for entity', () => {
    const sql = buildEntityDetailQuery(
      {
        entity: asEntityRef('core-banking'),
        dimension: asDimensionId('tag_org_team'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain("'core-banking'");
    expect(sql).toContain('usage_date');
    expect(sql).toContain('service');
  });
});
