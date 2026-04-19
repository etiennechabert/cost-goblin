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
  return buildCostQuery(baseParams, '/data', dimensions, 5, undefined, undefined, undefined, undefined, costScope);
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
    expect(sql).toMatch(/COALESCE\(reservation_effective_cost, savings_plan_effective_cost, line_item_unblended_cost, 0\) AS cost/);
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
    const sql = buildQuery({
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
    });
    expect(sql).toContain("NOT (service IN ('AWSSupport'))");
  });

  it('rule with multiple values uses IN list', () => {
    const sql = buildQuery({
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
    });
    expect(sql).toContain("line_item_type IN ('RIFee', 'SavingsPlanRecurringFee')");
    expect(sql).toContain('NOT (');
  });

  it('rule with multiple conditions uses AND', () => {
    const sql = buildQuery({
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
    });
    expect(sql).toContain("NOT (service IN ('EC2') AND service_family IN ('Compute'))");
  });

  it('tag dimension resolves through alias CASE', () => {
    const sql = buildCostQuery(
      { ...baseParams, groupBy: asDimensionId('service') },
      '/data',
      dimensions,
      5,
      undefined,
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
    expect(sql).toContain("'core-banking'");
    expect(sql).toContain('NOT (');
  });

  it('escapes single quotes in values', () => {
    const sql = buildQuery({
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
    });
    expect(sql).toContain("it''s a service");
    expect(sql).not.toContain("it's a service");
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
    const sql = buildCostQuery(
      baseParams,
      '/data',
      dimsWithNormalize,
      5,
      undefined,
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
    // IN-list — that would never match the LOWER(...) column.
    expect(sql).toContain("IN ('rifee', 'tax')");
    expect(sql).not.toContain("'RIFee'");
    expect(sql).not.toContain("'Tax'");
  });

  it('partially applies a rule when only some conditions are resolvable', () => {
    const sql = buildQuery({
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
    });
    // Resolvable condition still applies; dangling one is silently dropped.
    expect(sql).toContain("NOT (service IN ('EC2'))");
    expect(sql).not.toContain('nonexistent_dim');
  });
});

describe('buildDailyCostsQuery with costScope', () => {
  it('injects exclusion clause in daily costs query', () => {
    const sql = buildDailyCostsQuery(
      { ...baseParams, granularity: 'daily' },
      '/data',
      dimensions,
      undefined,
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
    expect(sql).toContain("NOT (service_family IN ('Support'))");
    expect(sql).toContain('line_item_blended_cost');
  });
});
