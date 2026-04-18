import { describe, it, expect } from 'vitest';
import { buildCostQuery, buildTrendQuery, buildMissingTagsQuery, buildNonResourceCostQuery, buildEntityDetailQuery, buildSource, computePeriodsInRange } from '../query/builder.js';
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
    // Parquet source is narrowed to the months the range touches, not the
    // year-wide wildcard.
    expect(sql).toContain("'/data/aws/raw/daily-2026-01/*.parquet'");
    expect(sql).not.toContain("daily-*/*.parquet");
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

describe('computePeriodsInRange', () => {
  it('returns the single month when start and end are in the same month', () => {
    expect(computePeriodsInRange({ start: '2026-04-01', end: '2026-04-18' })).toEqual(['2026-04']);
  });

  it('spans two adjacent months', () => {
    expect(computePeriodsInRange({ start: '2026-03-19', end: '2026-04-18' })).toEqual(['2026-03', '2026-04']);
  });

  it('spans a year boundary', () => {
    expect(computePeriodsInRange({ start: '2025-12-20', end: '2026-02-05' }))
      .toEqual(['2025-12', '2026-01', '2026-02']);
  });

  it('returns empty when start > end', () => {
    expect(computePeriodsInRange({ start: '2026-04-30', end: '2026-04-01' })).toEqual([]);
  });

  it('returns empty for invalid inputs', () => {
    expect(computePeriodsInRange({ start: 'not-a-date', end: '2026-04-01' })).toEqual([]);
  });
});

describe('buildSource narrowed paths', () => {
  it('emits read_parquet with a list of month paths when periods are given', () => {
    const sql = buildSource('/data', 'daily', dimensions, undefined, ['2026-03', '2026-04']);
    expect(sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
    expect(sql).not.toContain("daily-*/*.parquet");
  });

  it('falls back to the wildcard when periods are empty or omitted', () => {
    const sql = buildSource('/data', 'daily', dimensions, undefined, []);
    expect(sql).toContain("read_parquet('/data/aws/raw/daily-*/*.parquet')");
    const sql2 = buildSource('/data', 'daily', dimensions);
    expect(sql2).toContain("read_parquet('/data/aws/raw/daily-*/*.parquet')");
  });

  it('uses the hourly prefix when tier is hourly', () => {
    const sql = buildSource('/data', 'hourly', dimensions, undefined, ['2026-04']);
    expect(sql).toContain("'/data/aws/raw/hourly-2026-04/*.parquet'");
  });
});

describe('buildTrendQuery', () => {
  it('includes periods from both current and previous spans', () => {
    // 30-day window ending 2026-04-18 → current is 2026-03/2026-04, previous
    // is 2026-02-18 to 2026-03-18 → 2026-02/2026-03. Union: Feb, Mar, Apr.
    const sql = buildTrendQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-03-20'), end: asDateString('2026-04-18') },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain("'/data/aws/raw/daily-2026-02/*.parquet'");
    expect(sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
  });
});

describe('buildMissingTagsQuery', () => {
  const baseParams = {
    dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
    filters: {},
    minCost: asDollars(50),
    tagDimension: asDimensionId('tag_org_team'),
  };

  it('filters to resource-bound Usage lines (excludes Tax / Support / empty resource_id)', () => {
    const sql = buildMissingTagsQuery(baseParams, '/data', dimensions);
    expect(sql).toContain("line_item_type IN ('Usage', 'DiscountedUsage')");
    expect(sql).toContain("resource_id IS NOT NULL AND resource_id != ''");
  });

  it('computes has_tag per resource and category tagged_ratio', () => {
    const sql = buildMissingTagsQuery(baseParams, '/data', dimensions);
    // Resource is tagged if ANY line for it has the tag populated — MAX over a
    // CASE expression does exactly that.
    expect(sql).toContain('MAX(CASE WHEN');
    expect(sql).toContain('AS has_tag');
    // Category coverage divides tagged cost by total cost.
    expect(sql).toContain('tagged_ratio');
    expect(sql).toContain('SUM(CASE WHEN has_tag = 1 THEN cost ELSE 0 END)');
  });

  it('buckets into actionable (ratio > 0) vs likely-untaggable (ratio = 0)', () => {
    const sql = buildMissingTagsQuery(baseParams, '/data', dimensions);
    expect(sql).toContain("WHEN c.tagged_ratio > 0 THEN 'actionable'");
    expect(sql).toContain("ELSE 'likely-untaggable'");
  });

  it('applies minCost to the per-resource cost after classification', () => {
    const sql = buildMissingTagsQuery(baseParams, '/data', dimensions);
    expect(sql).toContain('r.cost >= 50');
  });
});

describe('buildNonResourceCostQuery', () => {
  it('captures non-Usage lines and Usage lines with no resource_id', () => {
    const sql = buildNonResourceCostQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_org_team'),
      },
      '/data',
      dimensions,
    );
    expect(sql).toContain("line_item_type NOT IN ('Usage', 'DiscountedUsage')");
    expect(sql).toContain("OR resource_id IS NULL OR resource_id = ''");
    expect(sql).toContain('GROUP BY service, service_family, line_item_type');
  });
});

describe('buildSource with account tag fallback', () => {
  it('generates COALESCE with raw fallback when no template', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'system', label: 'System', concept: 'product', accountTagFallback: 'sb:system' }],
    };
    const sql = buildSource('/data', 'daily', dims, '/org-tags.json');
    expect(sql).toContain('COALESCE(NULLIF(');
    expect(sql).toContain('fallback_tag_system');
    expect(sql).not.toContain('unknown');
  });

  it('generates formatted COALESCE when missingValueTemplate is set', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'system', label: 'System', concept: 'product', accountTagFallback: 'sb:owner', missingValueTemplate: 'unknown-{fallback}' }],
    };
    const sql = buildSource('/data', 'daily', dims, '/org-tags.json');
    expect(sql).toContain("'unknown-'");
    expect(sql).toContain('fallback_tag_system');
    expect(sql).toContain('COALESCE');
  });

  it('uses passthrough when template is {fallback}', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'team', label: 'Team', accountTagFallback: 'sb:team', missingValueTemplate: '{fallback}' }],
    };
    const sql = buildSource('/data', 'daily', dims, '/org-tags.json');
    expect(sql).toContain('COALESCE(NULLIF(');
    expect(sql).toContain('fallback_tag_team');
    // Should NOT contain string concatenation — {fallback} is passthrough
    expect(sql).not.toContain("'' ||");
  });

  it('does not JOIN when no orgAccountsPath', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'system', label: 'System', accountTagFallback: 'sb:system' }],
    };
    const sql = buildSource('/data', 'daily', dims);
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).not.toContain('fallback');
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
