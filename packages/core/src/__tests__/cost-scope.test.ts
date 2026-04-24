import { describe, it, expect } from 'vitest';
import {
  buildCostQuery,
  buildDailyCostsQuery,
} from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import { DEFAULT_COST_SCOPE } from '../config/cost-scope-seed.js';
import { asDimensionId, asDateString } from '../types/branded.js';

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('service_family'), label: 'Service Category', field: 'service_family' },
    { name: asDimensionId('line_item_type'), label: 'Line Item Type', field: 'line_item_type' },
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
  ],
  tags: [
    {
      tagName: 'org:team',
      label: 'Team',
      concept: 'owner',
      normalize: 'lowercase-kebab',
      aliases: { 'core-banking': ['core_banking', 'corebanking'] },
    },
  ],
};

const dateRange = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };
const baseParams = {
  groupBy: asDimensionId('service'),
  dateRange,
  filters: {},
};

function buildQuery(costScope?: CostScopeConfig): string {
  return buildCostQuery(baseParams, '/data', dimensions, 5, undefined, undefined, undefined, costScope).sql;
}

describe('cost metric column selection', () => {
  it('defaults to unblended when no costScope given', () => {
    const sql = buildQuery();
    // `AS cost` alias is backed by unblended; pricing_public_on_demand_cost
    // still appears as `AS list_cost` which is a separate column.
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
  });

  it('uses unblended when metric is unblended', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [] });
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
    expect(sql).not.toContain('line_item_blended_cost');
  });

  it('uses blended when metric is blended', () => {
    const sql = buildQuery({ costMetric: 'blended', rules: [] });
    expect(sql).toMatch(/COALESCE\(line_item_blended_cost, 0\) AS cost/);
  });

  it('falls back through effective cost → unblended when metric is amortized', () => {
    const sql = buildQuery({ costMetric: 'amortized', rules: [] });
    // Amortized layers effective-cost columns over unblended via COALESCE.
    expect(sql).toMatch(/COALESCE\(reservation_effective_cost, savings_plan_savings_plan_effective_cost, line_item_unblended_cost, 0\) AS cost/);
  });

  it('net perspective uses line_item_net_unblended_cost when available', () => {
    // Manually call buildCostQuery with a costScope that has costPerspective='net'
    // and a full availableColumns set including net columns. The generated
    // SQL should prefer the net variant.
    const { sql } = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      { costMetric: 'unblended', costPerspective: 'net', rules: [] },
      new Set(['line_item_unblended_cost', 'line_item_net_unblended_cost']),
    );
    expect(sql).toContain('line_item_net_unblended_cost');
  });

  it('net perspective falls back to gross column when net column missing', () => {
    // availableColumns omits line_item_net_unblended_cost — the expression
    // should degrade to the gross unblended column rather than reference
    // a missing column (which would error at query time).
    const { sql } = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      { costMetric: 'unblended', costPerspective: 'net', rules: [] },
      new Set(['line_item_unblended_cost']),
    );
    expect(sql).not.toContain('line_item_net_unblended_cost');
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
  });

  it('amortized + net uses net effective-cost columns when available', () => {
    const { sql } = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      { costMetric: 'amortized', costPerspective: 'net', rules: [] },
      new Set([
        'line_item_unblended_cost',
        'line_item_net_unblended_cost',
        'reservation_net_effective_cost',
        'savings_plan_net_savings_plan_effective_cost',
      ]),
    );
    expect(sql).toMatch(/COALESCE\(reservation_net_effective_cost, savings_plan_net_savings_plan_effective_cost, line_item_net_unblended_cost, line_item_unblended_cost, 0\) AS cost/);
  });

  it('amortized + net degrades to unblended when no net/effective columns present', () => {
    // No resource IDs (no effective_cost) and no net columns — amortized
    // degrades all the way down to line_item_unblended_cost.
    const { sql } = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      { costMetric: 'amortized', costPerspective: 'net', rules: [] },
      new Set(['line_item_unblended_cost']),
    );
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
    expect(sql).not.toContain('net_effective_cost');
    expect(sql).not.toContain('net_unblended_cost');
  });
});

describe('exclusion clauses', () => {
  it('produces no exclusion when rules array is empty', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [] });
    expect(sql).not.toContain('NOT (');
  });

  it('disabled rule produces no clause', () => {
    const sql = buildQuery({
      costMetric: 'unblended',
      rules: [
        {
          id: 'test',
          name: 'Test',
          enabled: false,
          builtIn: false,
          conditions: [{ dimensionId: asDimensionId('service'), values: ['EC2'] }],
        },
      ],
    });
    expect(sql).not.toContain('NOT (');
  });

  it('enabled rule with one condition produces NOT IN clause', () => {
    const result = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            builtIn: false,
            conditions: [{ dimensionId: asDimensionId('service'), values: ['AWSSupport'] }],
          },
        ],
      },
    );
    expect(result.sql).toContain('NOT (service IN ($');
    expect(result.params).toContain('AWSSupport');
  });

  it('rule with multiple values uses IN list', () => {
    const result = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            builtIn: false,
            conditions: [
              { dimensionId: asDimensionId('line_item_type'), values: ['RIFee', 'SavingsPlanRecurringFee'] },
            ],
          },
        ],
      },
    );
    expect(result.sql).toContain('line_item_type IN ($');
    expect(result.params).toContain('RIFee');
    expect(result.params).toContain('SavingsPlanRecurringFee');
    expect(result.sql).toContain('NOT (');
  });

  it('rule with multiple conditions uses AND', () => {
    const result = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            builtIn: false,
            conditions: [
              { dimensionId: asDimensionId('service'), values: ['EC2'] },
              { dimensionId: asDimensionId('service_family'), values: ['Compute'] },
            ],
          },
        ],
      },
    );
    expect(result.sql).toContain('NOT (service IN ($');
    expect(result.sql).toContain('AND service_family IN ($');
    expect(result.params).toContain('EC2');
    expect(result.params).toContain('Compute');
  });

  it('tag dimension resolves through alias CASE', () => {
    const { sql, params } = buildCostQuery(
      { ...baseParams, groupBy: asDimensionId('service') },
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            builtIn: false,
            conditions: [
              { dimensionId: asDimensionId('tag_org_team'), values: ['core-banking'] },
            ],
          },
        ],
      },
    );
    // Tag dim resolves via CASE expression
    expect(sql).toContain('CASE');
    expect(params).toContain('core-banking');
    expect(sql).toContain('NOT (');
  });

  it('escapes single quotes in values', () => {
    const result = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            builtIn: false,
            conditions: [
              { dimensionId: asDimensionId('service'), values: ["it's a service"] },
            ],
          },
        ],
      },
    );
    // With parameterized queries, the value is passed as a parameter
    // and doesn't need escaping in the SQL
    expect(result.params).toContain("it's a service");
    expect(result.sql).toContain('IN ($');
  });

  it('DEFAULT_COST_SCOPE built-in rules are disabled by default — no exclusions', () => {
    const sql = buildQuery(DEFAULT_COST_SCOPE);
    expect(sql).not.toContain('NOT (');
  });

  it('skips rule when dimensionId does not exist in current config', () => {
    // Stale rule: references a dimension that was deleted/renamed. Must
    // become a no-op rather than emitting a bogus column reference that
    // would crash every query.
    const sql = buildQuery({
      costMetric: 'unblended',
      rules: [
        {
          id: 'stale',
          name: 'Stale',
          enabled: true,
          builtIn: false,
          conditions: [{ dimensionId: asDimensionId('nonexistent_dim'), values: ['foo'] }],
        },
      ],
    });
    expect(sql).not.toContain('NOT (');
    expect(sql).not.toContain('nonexistent_dim');
  });

  it('applies the target dim normalize + alias to rule values', () => {
    // User normalises line_item_type to lowercase and aliases 'rifee' to
    // include 'reserved_instance_fee'. The built-in rule still stores the
    // raw CUR codes ('RIFee'); at SQL-build time those should be
    // normalised+alias-resolved to match the column's transformed output.
    const dimsWithNormalize: DimensionsConfig = {
      builtIn: [
        ...dimensions.builtIn.filter(d => d.name !== 'line_item_type'),
        {
          name: asDimensionId('line_item_type'),
          label: 'Line Item Type',
          field: 'line_item_type',
          normalize: 'lowercase',
          aliases: { rifee: ['reserved_instance_fee'] },
        },
      ],
      tags: dimensions.tags,
    };
    const { params } = buildCostQuery(
      baseParams,
      '/data',
      dimsWithNormalize,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'test',
            name: 'Test',
            enabled: true,
            builtIn: false,
            conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['RIFee', 'Tax'] }],
          },
        ],
      },
    );
    // Values become 'rifee' (lowercase + alias canonicalises to itself) and
    // 'tax' (lowercase). The raw 'RIFee' / 'Tax' must not appear in the
    // params — they should be normalized.
    expect(params).toContain('rifee');
    expect(params).toContain('tax');
    expect(params).not.toContain('RIFee');
    expect(params).not.toContain('Tax');
  });

  it('partially applies a rule when only some conditions are resolvable', () => {
    const result = buildCostQuery(
      baseParams,
      '/data',
      dimensions,
      5,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'unblended',
        rules: [
          {
            id: 'mixed',
            name: 'Mixed',
            enabled: true,
            builtIn: false,
            conditions: [
              { dimensionId: asDimensionId('service'), values: ['EC2'] },
              { dimensionId: asDimensionId('nonexistent_dim'), values: ['foo'] },
            ],
          },
        ],
      },
    );
    // Resolvable condition still applies; dangling one is silently dropped.
    expect(result.sql).toContain('NOT (service IN ($');
    expect(result.params).toContain('EC2');
    expect(result.sql).not.toContain('nonexistent_dim');
  });
});

describe('buildDailyCostsQuery with costScope', () => {
  it('injects exclusion clause in daily costs query', () => {
    const { sql, params } = buildDailyCostsQuery(
      { ...baseParams, granularity: 'daily' },
      '/data',
      dimensions,
      undefined,
      undefined,
      undefined,
      {
        costMetric: 'blended',
        rules: [
          {
            id: 'support',
            name: 'Support',
            enabled: true,
            builtIn: true,
            conditions: [{ dimensionId: asDimensionId('service_family'), values: ['Support'] }],
          },
        ],
      },
    );
    expect(sql).toContain('NOT (service_family IN ($');
    expect(params).toContain('Support');
    expect(sql).toContain('line_item_blended_cost');
  });
});
