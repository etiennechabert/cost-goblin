import { describe, it, expect } from 'vitest';
import { buildCostQuery, buildTrendQuery, buildMissingTagsQuery, buildEntityDetailQuery, buildSource } from '../query/builder.js';
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
    expect(sql).toContain("read_parquet('/data/aws/raw/daily-*/*.parquet')");
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
