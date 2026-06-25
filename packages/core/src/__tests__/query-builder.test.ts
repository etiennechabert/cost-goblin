import { describe, it, expect } from 'vitest';
import { buildCostQuery, buildDailyCostsQuery, buildTrendQuery, buildMissingTagsQuery, buildNonResourceCostQuery, buildEntityDetailQuery, buildSource, computePeriodsInRange } from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId, asDateString, asDollars, asEntityRef, asHourString, asTagValue } from '../types/branded.js';

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
    const result = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain('service AS entity');
    expect(result.sql).toContain('usage_date BETWEEN');
    // Parquet source is narrowed to the months the range touches, not the
    // year-wide wildcard.
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-01/*.parquet'");
    expect(result.sql).not.toContain("daily-*/*.parquet");
    // Verify date parameters
    expect(result.params).toContain('2026-01-01');
    expect(result.params).toContain('2026-01-31');
    expect(result.params).toContain(5); // default topN
  });

  it('includes filter clauses', () => {
    const result = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: { [asDimensionId('account')]: [asTagValue('111111111111')] },
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain('account_id = $');
    expect(result.params).toContain('2026-01-01');
    expect(result.params).toContain('2026-01-31');
    expect(result.params).toContain('111111111111');
  });

  it('uses alias SQL for tag dimensions', () => {
    const result = buildCostQuery(
      {
        groupBy: asDimensionId('tag_org_team'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain('CASE');
    expect(result.sql).toContain("'core-banking'");
  });
});

describe('buildTrendQuery', () => {
  it('generates SQL with period comparison', () => {
    const result = buildTrendQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-02-01'), end: asDateString('2026-02-28') },
        filters: {},
        deltaThreshold: asDollars(100),
        percentThreshold: 10,
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain('current_cost');
    expect(result.sql).toContain('previous_cost');
    expect(result.sql).toContain('delta');
    // Verify date parameters
    expect(result.params).toContain('2026-02-01');
    expect(result.params).toContain('2026-02-28');
    // Verify deltaThreshold parameter
    expect(result.params).toContain(100);
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
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions, periods: ['2026-03', '2026-04'] });
    expect(sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
    expect(sql).not.toContain("daily-*/*.parquet");
    // union_by_name tolerates CUR schema drift between months (older exports
    // lack the effective-cost columns the amortized expression references).
    expect(sql).toContain('union_by_name=true');
  });

  it('falls back to the wildcard when periods are empty or omitted', () => {
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions, periods: [] });
    expect(sql).toContain("read_parquet('/data/aws/raw/daily-*/*.parquet', union_by_name=true)");
    const sql2 = buildSource({ dataDir: '/data', tier: 'daily', dimensions });
    expect(sql2).toContain("read_parquet('/data/aws/raw/daily-*/*.parquet', union_by_name=true)");
  });

  it('uses the hourly prefix when tier is hourly', () => {
    const sql = buildSource({ dataDir: '/data', tier: 'hourly', dimensions, periods: ['2026-04'] });
    expect(sql).toContain("'/data/aws/raw/hourly-2026-04/*.parquet'");
  });
});

describe('buildTrendQuery with fallback-bearing tag dim', () => {
  // Mirrors the user's real-world `user_sb_system` setup: resource-tag + account
  // fallback + missingValueTemplate + normalize + aliases. The trend query needs
  // to compile cleanly and reference the materialized column in the alias CASE.
  const dims: DimensionsConfig = {
    builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
    tags: [{
      tagName: 'user_sb_system',
      label: 'System',
      concept: 'product',
      normalize: 'lowercase',
      aliases: {
        'core-banking': ['core_banking', 'corebanking'],
        'platform': ['cpe'],
      },
      accountTagFallback: 'sb:account-owner',
      missingValueTemplate: 'unknown-{fallback}',
    }],
  };

  it('produces SQL referencing the materialized column in the alias CASE', () => {
    const { sql } = buildTrendQuery(
      {
        groupBy: asDimensionId('tag_user_sb_system'),
        dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      { dataDir: '/data', dimensions: dims, orgAccountsPath: '/org.json' },
    );
    // The COALESCE / missingValueTemplate expression lives in the source subquery.
    expect(sql).toContain("COALESCE(NULLIF(element_at(cur.resource_tags, 'user_sb_system')[1], '')");
    expect(sql).toContain("'unknown-' || acct_tags.fallback_tag_user_sb_system || ''");
    // The OUTER group-by references the bare column name (not the COALESCE), so
    // the alias CASE doesn't repeat the full expression for every WHEN.
    expect(sql).toContain('LOWER(tag_user_sb_system)');
    expect(sql).toContain("WHEN LOWER(tag_user_sb_system) IN ('core_banking', 'corebanking') THEN 'core-banking'");
    expect(sql).not.toContain("WHEN LOWER(COALESCE");
  });

  it('runs cleanly with the user-style materializedSource path too', () => {
    const { sql } = buildTrendQuery(
      {
        groupBy: asDimensionId('tag_user_sb_system'),
        dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      { dataDir: '/data', dimensions: dims, orgAccountsPath: '/org.json', materializedSource: 'mat_table' },
    );
    expect(sql).toContain('FROM mat_table');
    expect(sql).toContain('LOWER(tag_user_sb_system)');
  });
});

describe('buildTrendQuery', () => {
  it('includes periods from both current and previous spans', () => {
    // 30-day window ending 2026-04-18 → current is 2026-03/2026-04, previous
    // is 2026-02-18 to 2026-03-18 → 2026-02/2026-03. Union: Feb, Mar, Apr.
    const result = buildTrendQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-03-20'), end: asDateString('2026-04-18') },
        filters: {},
        deltaThreshold: asDollars(0),
        percentThreshold: 0,
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-02/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-03/*.parquet'");
    expect(result.sql).toContain("'/data/aws/raw/daily-2026-04/*.parquet'");
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
    const result = buildMissingTagsQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain("line_item_type IN ('Usage', 'DiscountedUsage')");
    expect(result.sql).toContain("resource_id IS NOT NULL AND resource_id != ''");
    expect(result.sql).toContain('usage_date BETWEEN');
    // Verify date parameters
    expect(result.params).toContain('2026-01-01');
    expect(result.params).toContain('2026-01-31');
  });

  it('computes has_tag per resource and category tagged_ratio', () => {
    const result = buildMissingTagsQuery(baseParams, { dataDir: '/data', dimensions });
    // Resource is tagged if ANY line for it has the tag populated — MAX over a
    // CASE expression does exactly that.
    expect(result.sql).toContain('MAX(CASE WHEN');
    expect(result.sql).toContain('AS has_tag');
    // Category coverage divides tagged cost by total cost.
    expect(result.sql).toContain('tagged_ratio');
    expect(result.sql).toContain('SUM(CASE WHEN has_tag = 1 THEN cost ELSE 0 END)');
  });

  it('buckets into actionable (ratio > 0) vs likely-untaggable (ratio = 0)', () => {
    const result = buildMissingTagsQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).toContain("WHEN c.tagged_ratio > 0 THEN 'actionable'");
    expect(result.sql).toContain("ELSE 'likely-untaggable'");
  });

  it('does not filter by minCost in SQL (filtering is done in JS for distribution)', () => {
    const result = buildMissingTagsQuery(baseParams, { dataDir: '/data', dimensions });
    expect(result.sql).not.toContain('r.cost >= $');
  });

  it('treats default placeholder patterns as missing tags', () => {
    const result = buildMissingTagsQuery(baseParams, { dataDir: '/data', dimensions });
    // Each default placeholder pattern becomes a parameterized NOT ILIKE clause.
    expect(result.sql).toMatch(/NOT ILIKE \$\d+/);
    expect(result.params).toContain('unknown-%');
    expect(result.params).toContain('unknown_%');
    expect(result.params).toContain('unassigned-%');
    expect(result.params).toContain('none');
    expect(result.params).toContain('n/a');
    expect(result.params).toContain('tbd');
  });

  it('uses custom placeholder patterns when provided', () => {
    const result = buildMissingTagsQuery(
      { ...baseParams, placeholderPatterns: ['placeholder-%', 'TODO'] },
      { dataDir: '/data', dimensions },
    );
    expect(result.params).toContain('placeholder-%');
    expect(result.params).toContain('TODO');
    expect(result.params).not.toContain('unknown-%');
    expect(result.params).not.toContain('none');
  });

  it('treats empty placeholderPatterns as no placeholder filtering', () => {
    const result = buildMissingTagsQuery(
      { ...baseParams, placeholderPatterns: [] },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).not.toContain('NOT ILIKE');
    expect(result.params).not.toContain('unknown-%');
    expect(result.params).not.toContain('none');
  });
});

describe('buildNonResourceCostQuery', () => {
  it('captures non-Usage lines and Usage lines with no resource_id', () => {
    const result = buildNonResourceCostQuery(
      {
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_org_team'),
      },
      { dataDir: '/data', dimensions },
    );
    expect(result.sql).toContain("line_item_type NOT IN ('Usage', 'DiscountedUsage')");
    expect(result.sql).toContain("OR resource_id IS NULL OR resource_id = ''");
    expect(result.sql).toContain('GROUP BY service, service_family, line_item_type');
    expect(result.sql).toContain('usage_date BETWEEN');
    // Verify date parameters
    expect(result.params).toContain('2026-01-01');
    expect(result.params).toContain('2026-01-31');
  });
});

describe('buildSource with account tag fallback', () => {
  it('generates COALESCE with raw fallback when no template', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'system', label: 'System', concept: 'product', accountTagFallback: 'sb:system' }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    expect(sql).toContain('COALESCE(NULLIF(');
    expect(sql).toContain('fallback_tag_system');
    expect(sql).not.toContain('unknown');
  });

  it('generates formatted COALESCE when missingValueTemplate is set', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'system', label: 'System', concept: 'product', accountTagFallback: 'sb:owner', missingValueTemplate: 'unknown-{fallback}' }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    expect(sql).toContain("'unknown-'");
    expect(sql).toContain('fallback_tag_system');
    expect(sql).toContain('COALESCE');
  });

  it('uses passthrough when template is {fallback}', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'team', label: 'Team', accountTagFallback: 'sb:team', missingValueTemplate: '{fallback}' }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
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
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims });
    expect(sql).not.toContain('LEFT JOIN');
    expect(sql).not.toContain('fallback');
  });

  it('reads ouPath from org-accounts when accountTagFallback is the OU Path sentinel', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ tagName: 'team', label: 'Team', accountTagFallback: '__ouPath__' }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    expect(sql).toContain('ouPath AS fallback_tag_team');
    expect(sql).toContain('COALESCE(NULLIF(');
  });

  it('emits account-source-only column when tagName is omitted', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{ label: 'Department', accountTagFallback: '__ouPath__' }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    // Column name derives from "ou_path" since no tagName was provided.
    expect(sql).toContain('acct_tags.fallback_tag_ou_path AS tag_ou_path');
    expect(sql).toContain('ouPath AS fallback_tag_ou_path');
    // No resource-tag COALESCE — there is no resource tag to read.
    expect(sql).not.toContain('element_at(cur.resource_tags');
  });

  it('wraps the resolved value with split_part when pathSegment is set', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{
        tagName: 'department',
        label: 'Department',
        accountTagFallback: '__ouPath__',
        pathSegment: { separator: ' / ', index: 1 },
      }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    expect(sql).toContain("split_part(COALESCE(NULLIF(element_at(cur.resource_tags, 'user_department')[1], ''), acct_tags.fallback_tag_department), ' / ', 1)");
    expect(sql).toContain('AS tag_department');
  });

  it('segments an account-source-only column', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{
        label: 'Unit',
        accountTagFallback: '__ouPath__',
        pathSegment: { separator: ' / ', index: 1 },
      }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    expect(sql).toContain("split_part(acct_tags.fallback_tag_ou_path, ' / ', 1)");
    expect(sql).toContain('AS tag_ou_path');
  });

  it('supports negative segment indices', () => {
    const dims: DimensionsConfig = {
      builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id' }],
      tags: [{
        label: 'Environment',
        accountTagFallback: '__ouPath__',
        pathSegment: { separator: ' / ', index: -1 },
      }],
    };
    const sql = buildSource({ dataDir: '/data', tier: 'daily', dimensions: dims, orgAccountsPath: '/org-tags.json' });
    expect(sql).toContain("split_part(acct_tags.fallback_tag_ou_path, ' / ', -1)");
  });
});

describe('buildEntityDetailQuery', () => {
  it('generates detail query for entity', () => {
    const { sql, params } = buildEntityDetailQuery(
      {
        entity: asEntityRef('core-banking'),
        dimension: asDimensionId('tag_org_team'),
        dateRange: { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') },
        filters: {},
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('$');
    expect(params).toContain('2026-01-01');
    expect(params).toContain('2026-01-31');
    expect(params).toContain('core-banking');
    expect(sql).toContain('usage_date');
    expect(sql).toContain('service');
  });
});

describe('hour-bounded date ranges', () => {
  const hourRange = {
    start: asDateString('2026-04-30'),
    end: asDateString('2026-04-30'),
    startHour: asHourString('2026-04-30 14:00:00'),
    endHour: asHourString('2026-04-30 17:00:00'),
  };

  it('buildCostQuery filters on usage_hour and forces the hourly tier', () => {
    const { sql, params } = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: hourRange,
        filters: {},
        granularity: 'hourly',
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('usage_hour BETWEEN');
    expect(sql).toContain('::TIMESTAMP');
    expect(sql).not.toContain('usage_date BETWEEN');
    expect(sql).toContain("'/data/aws/raw/hourly-2026-04/*.parquet'");
    expect(params).toContain('2026-04-30 14:00:00');
    expect(params).toContain('2026-04-30 17:00:00');
  });

  it('buildDailyCostsQuery filters on usage_hour and groups by hour', () => {
    const { sql } = buildDailyCostsQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: hourRange,
        filters: {},
        granularity: 'hourly',
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('usage_hour BETWEEN');
    // Mid-hour fee timestamps round to nearest hour (see buildDailyCostsQuery).
    expect(sql).toContain("strftime(date_trunc('hour', usage_hour + INTERVAL '30 minutes'), '%Y-%m-%d %H:00')");
    expect(sql).not.toContain('usage_date BETWEEN');
  });

  it('buildEntityDetailQuery filters on usage_hour when hour bounds are set', () => {
    const { sql, params } = buildEntityDetailQuery(
      {
        entity: asEntityRef('core-banking'),
        dimension: asDimensionId('tag_org_team'),
        dateRange: hourRange,
        filters: {},
        granularity: 'hourly',
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('usage_hour BETWEEN');
    expect(params).toContain('2026-04-30 14:00:00');
    expect(params).toContain('2026-04-30 17:00:00');
  });

  it('promotes daily-only callers (missing tags) to hourly tier when hour bounds are set', () => {
    const { sql } = buildMissingTagsQuery(
      {
        dateRange: hourRange,
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_org_team'),
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('usage_hour BETWEEN');
    expect(sql).toContain("'/data/aws/raw/hourly-2026-04/*.parquet'");
  });

  it('promotes non-resource cost to hourly tier when hour bounds are set', () => {
    const { sql } = buildNonResourceCostQuery(
      {
        dateRange: hourRange,
        filters: {},
        minCost: asDollars(0),
        tagDimension: asDimensionId('tag_org_team'),
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('usage_hour BETWEEN');
    expect(sql).toContain("'/data/aws/raw/hourly-2026-04/*.parquet'");
  });

  it('falls back to date filter when hour bounds are not set', () => {
    const { sql } = buildCostQuery(
      {
        groupBy: asDimensionId('service'),
        dateRange: { start: asDateString('2026-04-01'), end: asDateString('2026-04-30') },
        filters: {},
        granularity: 'daily',
      },
      { dataDir: '/data', dimensions },
    );
    expect(sql).toContain('usage_date BETWEEN');
    expect(sql).not.toContain('usage_hour BETWEEN');
  });
});
