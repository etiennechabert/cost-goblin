import { describe, it, expect } from 'vitest';
import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildMaterializeBaseQuery,
  buildRollupPartitionQuery,
  buildGrainProbeQuery,
} from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { DEFAULT_COST_SCOPE, DEFAULT_MARKETPLACE_ATTRIBUTION, BUILTIN_EXCLUSION_RULES, mergeBuiltInExclusionRules } from '../config/cost-scope-seed.js';
import { validateCostScope } from '../config/cost-scope-validator.js';
import { costScopeToYaml } from '../config/cost-scope-serialize.js';
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
  return buildCostQuery(baseParams, { dataDir: '/data', dimensions, costScope }, 5).sql;
}

describe('cost metric column selection', () => {
  it('defaults to unblended when no costScope given', () => {
    const sql = buildQuery();
    // `AS cost` alias is backed by unblended; pricing_public_on_demand_cost
    // still appears as `AS list_cost` which is a separate column.
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
  });

  it('amortized uses CASE on line_item_type per AWS amortized definition', () => {
    const sql = buildQuery({ costMetric: 'amortized', rules: [] });
    // DiscountedUsage → reservation_effective_cost; SP-covered → SP effective;
    // RI/SP fee rows → 0 (already amortized into covered-usage); else unblended.
    expect(sql).toContain("WHEN line_item_line_item_type = 'DiscountedUsage' THEN COALESCE(reservation_effective_cost, line_item_unblended_cost, 0)");
    expect(sql).toContain("WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN COALESCE(savings_plan_savings_plan_effective_cost, line_item_unblended_cost, 0)");
    expect(sql).toContain("WHEN line_item_line_item_type IN ('RIFee', 'SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'SavingsPlanNegation') THEN 0");
    expect(sql).toContain('ELSE COALESCE(line_item_unblended_cost, 0)');
  });

  it('amortized does NOT use a flat COALESCE on effective-cost columns', () => {
    // Regression: AWS populates reservation_effective_cost / savings_plan_*_effective_cost
    // with 0 (not NULL) for non-applicable rows. A flat COALESCE returned 0 for every
    // Usage / Tax / Credit row and silently zeroed out ~90% of cost.
    const sql = buildQuery({ costMetric: 'amortized', rules: [] });
    expect(sql).not.toMatch(/COALESCE\(reservation_effective_cost, savings_plan_savings_plan_effective_cost, line_item_unblended_cost, 0\)/);
  });

  it('net perspective uses line_item_net_unblended_cost when available', () => {
    // Manually call buildCostQuery with a costScope that has costPerspective='net'
    // and a full availableColumns set including net columns. The generated
    // SQL should prefer the net variant.
    const { sql } = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: { costMetric: 'unblended', costPerspective: 'net', rules: [] }, availableColumns: new Set(['line_item_unblended_cost', 'line_item_net_unblended_cost']) },
      5,
    );
    expect(sql).toContain('line_item_net_unblended_cost');
  });

  it('net perspective falls back to gross column when net column missing', () => {
    // availableColumns omits line_item_net_unblended_cost — the expression
    // should degrade to the gross unblended column rather than reference
    // a missing column (which would error at query time).
    const { sql } = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: { costMetric: 'unblended', costPerspective: 'net', rules: [] }, availableColumns: new Set(['line_item_unblended_cost']) },
      5,
    );
    expect(sql).not.toContain('line_item_net_unblended_cost');
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
  });

  it('amortized + net uses net effective-cost columns when available', () => {
    const { sql } = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: { costMetric: 'amortized', costPerspective: 'net', rules: [] }, availableColumns: new Set([
        'line_item_unblended_cost',
        'line_item_net_unblended_cost',
        'reservation_net_effective_cost',
        'savings_plan_net_savings_plan_effective_cost',
      ]) },
      5,
    );
    expect(sql).toContain("WHEN line_item_line_item_type = 'DiscountedUsage' THEN COALESCE(reservation_net_effective_cost, line_item_net_unblended_cost, 0)");
    expect(sql).toContain("WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN COALESCE(savings_plan_net_savings_plan_effective_cost, line_item_net_unblended_cost, 0)");
    expect(sql).toContain('ELSE COALESCE(line_item_net_unblended_cost, 0)');
  });

  it('amortized + net degrades to unblended when no net/effective columns present', () => {
    // No resource IDs (no effective_cost) and no net columns — amortized
    // degrades all the way down to line_item_unblended_cost.
    const { sql } = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: { costMetric: 'amortized', costPerspective: 'net', rules: [] }, availableColumns: new Set(['line_item_unblended_cost']) },
      5,
    );
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
    expect(sql).not.toContain('net_effective_cost');
    expect(sql).not.toContain('net_unblended_cost');
  });

  it('list metric uses pricing_public_on_demand_cost', () => {
    const sql = buildQuery({ costMetric: 'list', rules: [] });
    expect(sql).toMatch(/COALESCE\(pricing_public_on_demand_cost, 0\) AS cost/);
  });

  it('list metric restricts source to usage-bearing line item types', () => {
    const sql = buildQuery({ costMetric: 'list', rules: [] });
    // Filter is inlined in the source subquery so every downstream query
    // (Explorer, custom views, MCP, materialized base) sees the same slice.
    expect(sql).toContain("line_item_line_item_type, '') IN ('Usage', 'SavingsPlanCoveredUsage', 'DiscountedUsage')");
  });

  it('list metric degrades to unblended when on-demand column missing', () => {
    const { sql } = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: { costMetric: 'list', rules: [] }, availableColumns: new Set(['line_item_unblended_cost']) },
      5,
    );
    expect(sql).toMatch(/COALESCE\(line_item_unblended_cost, 0\) AS cost/);
    expect(sql).not.toContain('pricing_public_on_demand_cost, 0) AS cost');
  });

  it('non-list metrics do not inject the line-item-type filter', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [] });
    expect(sql).not.toContain("'Usage', 'SavingsPlanCoveredUsage', 'DiscountedUsage'");
  });
});

describe('exclusion clauses', () => {
  it('produces no exclusion when rules array is empty', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [] });
    expect(sql).not.toContain('NOT IN');
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
    expect(sql).not.toContain('NOT IN');
    expect(sql).not.toContain('NOT (');
  });

  it('enabled rule with one condition produces NOT IN clause', () => {
    const result = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('service'), values: ['AWSSupport'] }] }],
      } },
      5,
    );
    // Single-condition rules merge into a NULL-safe COALESCE(dim NOT IN (...), TRUE)
    // form — a NULL dimension value must be kept, not silently dropped.
    expect(result.sql).toContain('COALESCE(service NOT IN ($');
    expect(result.sql).toContain('), TRUE)');
    expect(result.params).toContain('AWSSupport');
  });

  it('rule with multiple values uses NOT IN list', () => {
    const result = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['RIFee', 'SavingsPlanRecurringFee'] }] }],
      } },
      5,
    );
    // Single-condition rules merge into the NULL-safe COALESCE NOT IN form
    expect(result.sql).toContain('COALESCE(line_item_type NOT IN ($');
    expect(result.params).toContain('RIFee');
    expect(result.params).toContain('SavingsPlanRecurringFee');
  });

  it('rule with multiple conditions uses AND', () => {
    const result = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [
          { dimensionId: asDimensionId('service'), values: ['EC2'] },
          { dimensionId: asDimensionId('service_family'), values: ['Compute'] },
        ] }],
      } },
      5,
    );
    // Each condition COALESCEs to FALSE so the negated AND can never be NULL
    expect(result.sql).toContain('NOT (COALESCE(service IN ($');
    expect(result.sql).toContain('AND COALESCE(service_family IN ($');
    expect(result.params).toContain('EC2');
    expect(result.params).toContain('Compute');
  });

  it('tag dimension resolves through alias CASE', () => {
    const { sql, params } = buildCostQuery(
      { ...baseParams, groupBy: asDimensionId('service') },
      { dataDir: '/data', dimensions, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('tag_org_team'), values: ['core-banking'] }] }],
      } },
      5,
    );
    // Tag dim resolves via CASE expression with merged NOT IN form
    expect(sql).toContain('CASE');
    expect(params).toContain('core-banking');
    expect(sql).toContain('NOT IN ($');
  });

  it('DEFAULT_COST_SCOPE built-in rules are disabled by default — no exclusions', () => {
    const sql = buildQuery(DEFAULT_COST_SCOPE);
    expect(sql).not.toContain('NOT IN');
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
    expect(sql).not.toContain('NOT IN');
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
      { dataDir: '/data', dimensions: dimsWithNormalize, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['RIFee', 'Tax'] }] }],
      } },
      5,
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
      { dataDir: '/data', dimensions, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'mixed', name: 'Mixed', enabled: true, builtIn: false, conditions: [
          { dimensionId: asDimensionId('service'), values: ['EC2'] },
          { dimensionId: asDimensionId('nonexistent_dim'), values: ['foo'] },
        ] }],
      } },
      5,
    );
    // Resolvable condition still applies; dangling one is silently dropped.
    expect(result.sql).toContain('NOT (COALESCE(service IN ($');
    expect(result.params).toContain('EC2');
    expect(result.sql).not.toContain('nonexistent_dim');
  });

  it('DDL builders (materialize base, rollup partition, grain probe) emit the same NULL-safe clauses', () => {
    // Regression for issue #451: these three builders each carried their own
    // copy of the exclusion loop with plain `NOT (expr IN ...)`, which baked
    // the loss of every untagged row into the materialized base and the
    // persisted rollup partitions. All three now share buildExclusionClauses.
    const scope: CostScopeConfig = {
      costMetric: 'unblended',
      rules: [{ id: 'sandbox', name: 'Sandbox', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('tag_org_team'), values: ['sandbox'] }] }],
    };
    const ctx = { dataDir: '/data', dimensions, costScope: scope };
    const range = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };
    const ddls = [
      buildMaterializeBaseQuery('daily', range, ctx),
      buildRollupPartitionQuery('2026-01', 'daily', '/out/part.parquet', ctx),
      buildGrainProbeQuery('2026-01', ['usage_date', 'service'], ctx),
    ];
    for (const sql of ddls) {
      expect(sql).toContain("NOT IN ('sandbox'), TRUE)");
      expect(sql).toContain('COALESCE(');
    }
  });
});

describe('mergeBuiltInExclusionRules', () => {
  function retiredRiSpRule(enabled: boolean): ExclusionRule {
    return {
      id: 'builtin:ri-sp-purchases',
      name: 'RI & Savings Plan purchases',
      enabled,
      builtIn: true,
      conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['RIFee'] }],
    };
  }

  function retiredCoveredUsageRule(enabled: boolean): ExclusionRule {
    return {
      id: 'builtin:commitment-covered-usage',
      name: 'RI & SP covered usage',
      enabled,
      builtIn: true,
      conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['DiscountedUsage'] }],
    };
  }

  it('does not ship the retired RI/SP rules in the default seed', () => {
    const ids = BUILTIN_EXCLUSION_RULES.map(r => r.id);
    expect(ids).not.toContain('builtin:ri-sp-purchases');
    expect(ids).not.toContain('builtin:commitment-covered-usage');
  });

  it('drops retired rules from loaded configs silently', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'unblended',
      rules: [retiredRiSpRule(false), retiredCoveredUsageRule(false)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    const ids = merged.rules.map(r => r.id);
    expect(ids).not.toContain('builtin:ri-sp-purchases');
    expect(ids).not.toContain('builtin:commitment-covered-usage');
  });

  it('migrates costMetric to `list` when the retired ri-sp-purchases rule was enabled', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'unblended',
      rules: [retiredRiSpRule(true)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.costMetric).toBe('list');
  });

  it('does not change costMetric when ri-sp-purchases rule was disabled', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'amortized',
      rules: [retiredRiSpRule(false)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.costMetric).toBe('amortized');
  });

  it('preserves user-authored custom rules', () => {
    const customRule: ExclusionRule = {
      id: 'user-uuid',
      name: 'Custom',
      enabled: true,
      builtIn: false,
      conditions: [{ dimensionId: asDimensionId('service'), values: ['AmazonS3'] }],
    };
    const loaded: CostScopeConfig = {
      costMetric: 'unblended',
      rules: [retiredRiSpRule(false), customRule],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.rules.find(r => r.id === 'user-uuid')).toEqual(customRule);
  });

  it('backfills surviving built-ins missing from the loaded config', () => {
    const loaded: CostScopeConfig = { costMetric: 'unblended', rules: [] };
    const merged = mergeBuiltInExclusionRules(loaded);
    const ids = merged.rules.map(r => r.id);
    expect(ids).toContain('builtin:tax');
    expect(ids).toContain('builtin:aws-premium-support');
  });

  it('returns input unchanged when config is already coherent', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'unblended',
      rules: [...BUILTIN_EXCLUSION_RULES],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged).toBe(loaded);
  });
});

describe('validateCostScope: blended migration', () => {
  it('migrates costMetric "blended" to "amortized" silently', () => {
    const result = validateCostScope({ costMetric: 'blended', rules: [] });
    expect(result.costMetric).toBe('amortized');
  });

  it('rejects truly unknown costMetric values', () => {
    expect(() => validateCostScope({ costMetric: 'nonsense', rules: [] })).toThrow(/costScope.costMetric must be one of/);
  });
});

describe('marketplace attribution: SQL rewrite', () => {
  const bedrock = DEFAULT_MARKETPLACE_ATTRIBUTION;
  const matchPred = "COALESCE(product_servicecode, '') = '' AND line_item_operation IN ('InvokeModelInference', 'InvokeModelStreamingInference')";

  it('re-attributes matched empty-servicecode rows to the target service', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [], marketplaceAttribution: bedrock });
    expect(sql).toContain(`CASE WHEN ${matchPred} THEN 'AmazonBedrock' ELSE COALESCE(product_servicecode, '') END AS service`);
  });

  it('leaves service untouched when disabled', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [], marketplaceAttribution: { enabled: false, rules: bedrock.rules } });
    expect(sql).toContain("COALESCE(product_servicecode, '') AS service");
    expect(sql).not.toContain('AmazonBedrock');
  });

  it('leaves service untouched when no costScope is supplied', () => {
    const sql = buildQuery();
    expect(sql).toContain("COALESCE(product_servicecode, '') AS service");
    expect(sql).not.toContain('AmazonBedrock');
  });

  it('substitutes unblended for the $0 list price on the list metric', () => {
    const sql = buildQuery({ costMetric: 'list', rules: [], marketplaceAttribution: bedrock });
    expect(sql).toContain(`CASE WHEN ${matchPred} THEN COALESCE(line_item_unblended_cost, 0) ELSE COALESCE(pricing_public_on_demand_cost, 0) END AS cost`);
  });

  it('does NOT rewrite cost on unblended (the real charge is already there)', () => {
    const sql = buildQuery({ costMetric: 'unblended', rules: [], marketplaceAttribution: bedrock });
    expect(sql).toContain('COALESCE(line_item_unblended_cost, 0) AS cost');
    expect(sql).not.toContain('END AS cost');
  });
});

describe('validateCostScope: marketplace attribution', () => {
  it('defaults to the shipped enabled rule when the block is absent', () => {
    const r = validateCostScope({ costMetric: 'unblended', rules: [] });
    expect(r.marketplaceAttribution).toEqual(DEFAULT_MARKETPLACE_ATTRIBUTION);
  });

  it('honors an explicit disabled block (opt-out)', () => {
    const r = validateCostScope({ costMetric: 'unblended', rules: [], marketplaceAttribution: { enabled: false, rules: [] } });
    expect(r.marketplaceAttribution).toEqual({ enabled: false, rules: [] });
  });

  it('rejects a rule with no operations', () => {
    expect(() => validateCostScope({
      costMetric: 'unblended', rules: [],
      marketplaceAttribution: { enabled: true, rules: [{ service: 'X', operations: [] }] },
    })).toThrow(/operations must have at least one/);
  });

  it('rejects a rule with an empty service', () => {
    expect(() => validateCostScope({
      costMetric: 'unblended', rules: [],
      marketplaceAttribution: { enabled: true, rules: [{ service: '', operations: ['Op'] }] },
    })).toThrow(/service must be a non-empty/);
  });

  it('round-trips through YAML serialization', () => {
    const cfg = validateCostScope({ costMetric: 'unblended', rules: [] });
    expect(validateCostScope(costScopeToYaml(cfg))).toEqual(cfg);
  });
});

describe('buildDailyCostsQuery with costScope', () => {
  it('injects exclusion clause in daily costs query', () => {
    const { sql, params } = buildDailyCostsQuery(
      { ...baseParams, granularity: 'daily' },
      { dataDir: '/data', dimensions, costScope: {
        costMetric: 'unblended',
        rules: [{ id: 'support', name: 'Support', enabled: true, builtIn: true, conditions: [{ dimensionId: asDimensionId('service_family'), values: ['Support'] }] }],
      } },
    );
    // Single-condition rules use the merged NULL-safe NOT IN form
    expect(sql).toContain('COALESCE(service_family NOT IN ($');
    expect(params).toContain('Support');
    expect(sql).toContain('line_item_unblended_cost');
  });
});
