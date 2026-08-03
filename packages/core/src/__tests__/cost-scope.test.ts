import { describe, it, expect } from 'vitest';
import {
  buildCostQuery,
  buildDailyCostsQuery,
} from '../query/builder.js';
import type { DimensionsConfig } from '../types/config.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { DEFAULT_COST_SCOPE, DEFAULT_MARKETPLACE_ATTRIBUTION, BUILTIN_EXCLUSION_RULES, mergeBuiltInExclusionRules } from '../config/cost-scope-seed.js';
import { validateCostScope } from '../config/cost-scope-validator.js';
import { costScopeToYaml } from '../config/cost-scope-serialize.js';
import { asDimensionId, asDateString, asProviderName } from '../types/branded.js';

const PROVIDER = asProviderName('aws');

const dimensions: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('service_code'), label: 'Service Code', field: 'service_code' },
    { name: asDimensionId('service_category'), label: 'Service Category', field: 'service_category' },
    { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' },
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
  return buildCostQuery(baseParams, { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope }, 5).sql;
}

// NOTE (FOCUS 1.2 migration): the CUR-era tests for the amortized CASE
// expression, the gross/net costPerspective axis, and availableColumns-based
// column probing/fallback were removed together with their subjects — FOCUS
// exports always carry all four cost columns as direct reads, and net cost
// columns do not exist in FOCUS.
describe('cost metric column selection', () => {
  it('defaults to effective when no costScope given', () => {
    const sql = buildQuery();
    // `AS cost` alias is backed by EffectiveCost; ListCost still appears
    // as `AS list_cost` which is a separate column.
    expect(sql).toMatch(/COALESCE\(EffectiveCost, 0\) AS cost/);
    expect(sql).toMatch(/COALESCE\(ListCost, 0\) AS list_cost/);
  });

  it('billed reads BilledCost directly', () => {
    const sql = buildQuery({ costMetric: 'billed', rules: [] });
    expect(sql).toMatch(/COALESCE\(BilledCost, 0\) AS cost/);
  });

  it('effective reads EffectiveCost directly', () => {
    const sql = buildQuery({ costMetric: 'effective', rules: [] });
    expect(sql).toMatch(/COALESCE\(EffectiveCost, 0\) AS cost/);
  });

  it('contracted reads ContractedCost directly', () => {
    const sql = buildQuery({ costMetric: 'contracted', rules: [] });
    expect(sql).toMatch(/COALESCE\(ContractedCost, 0\) AS cost/);
  });

  it('list metric uses ListCost', () => {
    const sql = buildQuery({ costMetric: 'list', rules: [] });
    expect(sql).toMatch(/COALESCE\(ListCost, 0\) AS cost/);
  });

  it('list metric restricts source to usage-bearing charge categories', () => {
    const sql = buildQuery({ costMetric: 'list', rules: [] });
    // Filter is inlined in the source subquery so every downstream query
    // (Explorer, custom views, MCP, materialized base) sees the same slice.
    expect(sql).toContain("WHERE COALESCE(ChargeCategory, '') IN ('Usage')");
  });

  it('non-list metrics do not inject the charge-category filter', () => {
    for (const costMetric of ['billed', 'effective', 'contracted'] as const) {
      const sql = buildQuery({ costMetric, rules: [] });
      expect(sql).not.toContain("IN ('Usage')");
    }
  });
});

describe('exclusion clauses', () => {
  it('produces no exclusion when rules array is empty', () => {
    const sql = buildQuery({ costMetric: 'effective', rules: [] });
    expect(sql).not.toContain('NOT IN');
    expect(sql).not.toContain('NOT (');
  });

  it('disabled rule produces no clause', () => {
    const sql = buildQuery({
      costMetric: 'effective',
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
      { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'effective',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('service_code'), values: ['AWSSupportEnterprise'] }] }],
      } },
      5,
    );
    // Single-condition rules are merged into `dim NOT IN (...)` form
    expect(result.sql).toContain('service_code NOT IN ($');
    expect(result.params).toContain('AWSSupportEnterprise');
  });

  it('rule with multiple values uses NOT IN list', () => {
    const result = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'effective',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('charge_category'), values: ['Purchase', 'Tax'] }] }],
      } },
      5,
    );
    // Single-condition rules merge into `dim NOT IN (...)` form
    expect(result.sql).toContain('charge_category NOT IN ($');
    expect(result.params).toContain('Purchase');
    expect(result.params).toContain('Tax');
  });

  it('rule with multiple conditions uses AND', () => {
    const result = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'effective',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [
          { dimensionId: asDimensionId('service'), values: ['EC2'] },
          { dimensionId: asDimensionId('service_category'), values: ['Compute'] },
        ] }],
      } },
      5,
    );
    expect(result.sql).toContain('NOT (service IN ($');
    expect(result.sql).toContain('AND service_category IN ($');
    expect(result.params).toContain('EC2');
    expect(result.params).toContain('Compute');
  });

  it('tag dimension resolves through alias CASE', () => {
    const { sql, params } = buildCostQuery(
      { ...baseParams, groupBy: asDimensionId('service') },
      { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'effective',
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
      costMetric: 'effective',
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
    // User normalises charge_category to lowercase and aliases 'purchase' to
    // include 'commitment_purchase'. A rule can still store the raw FOCUS
    // codes ('Purchase'); at SQL-build time those should be
    // normalised+alias-resolved to match the column's transformed output.
    const dimsWithNormalize: DimensionsConfig = {
      builtIn: [
        ...dimensions.builtIn.filter(d => d.name !== 'charge_category'),
        {
          name: asDimensionId('charge_category'),
          label: 'Charge Category',
          field: 'charge_category',
          normalize: 'lowercase',
          aliases: { purchase: ['commitment_purchase'] },
        },
      ],
      tags: dimensions.tags,
    };
    const { params } = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions: dimsWithNormalize, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'effective',
        rules: [{ id: 'test', name: 'Test', enabled: true, builtIn: false, conditions: [{ dimensionId: asDimensionId('charge_category'), values: ['Purchase', 'Tax'] }] }],
      } },
      5,
    );
    // Values become 'purchase' (lowercase + alias canonicalises to itself)
    // and 'tax' (lowercase). The raw 'Purchase' / 'Tax' must not appear in
    // the params — they should be normalized.
    expect(params).toContain('purchase');
    expect(params).toContain('tax');
    expect(params).not.toContain('Purchase');
    expect(params).not.toContain('Tax');
  });

  it('partially applies a rule when only some conditions are resolvable', () => {
    const result = buildCostQuery(
      baseParams,
      { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'effective',
        rules: [{ id: 'mixed', name: 'Mixed', enabled: true, builtIn: false, conditions: [
          { dimensionId: asDimensionId('service'), values: ['EC2'] },
          { dimensionId: asDimensionId('nonexistent_dim'), values: ['foo'] },
        ] }],
      } },
      5,
    );
    // Resolvable condition still applies; dangling one is silently dropped.
    expect(result.sql).toContain('NOT (service IN ($');
    expect(result.params).toContain('EC2');
    expect(result.sql).not.toContain('nonexistent_dim');
  });
});

describe('mergeBuiltInExclusionRules', () => {
  it('repairs surviving built-in rules whose persisted conditions are exactly the CUR-era seed', () => {
    const staleTax: ExclusionRule = {
      id: 'builtin:tax',
      name: 'Tax (renamed by user)',
      enabled: true,
      builtIn: true,
      conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['Tax'] }],
    };
    const staleSupport: ExclusionRule = {
      id: 'builtin:aws-premium-support',
      name: 'AWS Premium Support',
      enabled: false,
      builtIn: true,
      conditions: [{
        dimensionId: asDimensionId('service'),
        values: ['AWSSupportEnterprise', 'AWSSupportBusiness', 'AWSSupportDeveloper'],
      }],
    };
    const merged = mergeBuiltInExclusionRules({ costMetric: 'effective', rules: [staleTax, staleSupport] });
    const tax = merged.rules.find(r => r.id === 'builtin:tax');
    const support = merged.rules.find(r => r.id === 'builtin:aws-premium-support');
    // Conditions adopt the FOCUS seed; user-owned fields (enabled, name) survive.
    expect(tax?.conditions).toEqual([{ dimensionId: 'charge_category', values: ['Tax'] }]);
    expect(tax?.enabled).toBe(true);
    expect(tax?.name).toBe('Tax (renamed by user)');
    expect(support?.conditions).toEqual([
      { dimensionId: 'service_code', values: ['AWSSupportEnterprise', 'AWSSupportBusiness', 'AWSSupportDeveloper'] },
    ]);
    expect(support?.enabled).toBe(false);
  });

  it('preserves user-edited built-in rule conditions (only exact legacy seed shapes are repaired)', () => {
    // The Cost Scope UI lets users edit built-in conditions (with its own
    // Reset affordance) — the merge must not clobber a deliberate edit.
    const narrowedSupport: ExclusionRule = {
      id: 'builtin:aws-premium-support',
      name: 'AWS Premium Support',
      enabled: true,
      builtIn: true,
      conditions: [{ dimensionId: asDimensionId('service'), values: ['AWSSupportEnterprise'] }],
    };
    const editedTax: ExclusionRule = {
      id: 'builtin:tax',
      name: 'Tax',
      enabled: true,
      builtIn: true,
      conditions: [
        { dimensionId: asDimensionId('charge_category'), values: ['Tax'] },
        { dimensionId: asDimensionId('account'), values: ['111111111111'] },
      ],
    };
    const merged = mergeBuiltInExclusionRules({ costMetric: 'effective', rules: [narrowedSupport, editedTax] });
    expect(merged.rules.find(r => r.id === 'builtin:aws-premium-support')?.conditions)
      .toEqual(narrowedSupport.conditions);
    expect(merged.rules.find(r => r.id === 'builtin:tax')?.conditions)
      .toEqual(editedTax.conditions);
  });

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

  function retiredEdpDiscountRule(enabled: boolean): ExclusionRule {
    return {
      id: 'builtin:edp-discount',
      name: 'EDP discount',
      enabled,
      builtIn: true,
      conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['EdpDiscount'] }],
    };
  }

  function retiredBundledDiscountRule(enabled: boolean): ExclusionRule {
    return {
      id: 'builtin:bundled-discount',
      name: 'Bundled discount',
      enabled,
      builtIn: true,
      conditions: [{ dimensionId: asDimensionId('line_item_type'), values: ['BundledDiscount'] }],
    };
  }

  it('ships exactly the two surviving built-in rules in the default seed', () => {
    const ids = BUILTIN_EXCLUSION_RULES.map(r => r.id);
    expect(ids).toEqual(['builtin:aws-premium-support', 'builtin:tax']);
  });

  it('does not ship any retired rule in the default seed', () => {
    const ids = BUILTIN_EXCLUSION_RULES.map(r => r.id);
    expect(ids).not.toContain('builtin:ri-sp-purchases');
    expect(ids).not.toContain('builtin:commitment-covered-usage');
    expect(ids).not.toContain('builtin:edp-discount');
    expect(ids).not.toContain('builtin:bundled-discount');
  });

  it('drops retired rules from loaded configs silently', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'effective',
      rules: [retiredRiSpRule(false), retiredCoveredUsageRule(false), retiredEdpDiscountRule(false), retiredBundledDiscountRule(false)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    const ids = merged.rules.map(r => r.id);
    expect(ids).not.toContain('builtin:ri-sp-purchases');
    expect(ids).not.toContain('builtin:commitment-covered-usage');
    expect(ids).not.toContain('builtin:edp-discount');
    expect(ids).not.toContain('builtin:bundled-discount');
  });

  it('migrates costMetric to `list` when the retired ri-sp-purchases rule was enabled', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'effective',
      rules: [retiredRiSpRule(true)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.costMetric).toBe('list');
  });

  it('does not change costMetric when ri-sp-purchases rule was disabled', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'billed',
      rules: [retiredRiSpRule(false)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.costMetric).toBe('billed');
  });

  it('does not change costMetric when only the retired discount rules were enabled', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'billed',
      rules: [retiredEdpDiscountRule(true), retiredBundledDiscountRule(true)],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.costMetric).toBe('billed');
  });

  it('preserves user-authored custom rules', () => {
    const customRule: ExclusionRule = {
      id: 'user-uuid',
      name: 'Custom',
      enabled: true,
      builtIn: false,
      conditions: [{ dimensionId: asDimensionId('service'), values: ['Amazon Simple Storage Service'] }],
    };
    const loaded: CostScopeConfig = {
      costMetric: 'effective',
      rules: [retiredRiSpRule(false), customRule],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged.rules.find(r => r.id === 'user-uuid')).toEqual(customRule);
  });

  it('backfills surviving built-ins missing from the loaded config', () => {
    const loaded: CostScopeConfig = { costMetric: 'effective', rules: [] };
    const merged = mergeBuiltInExclusionRules(loaded);
    const ids = merged.rules.map(r => r.id);
    expect(ids).toContain('builtin:tax');
    expect(ids).toContain('builtin:aws-premium-support');
  });

  it('returns input unchanged when config is already coherent', () => {
    const loaded: CostScopeConfig = {
      costMetric: 'effective',
      rules: [...BUILTIN_EXCLUSION_RULES],
    };
    const merged = mergeBuiltInExclusionRules(loaded);
    expect(merged).toBe(loaded);
  });
});

describe('validateCostScope: legacy metric migration', () => {
  it('migrates costMetric "unblended" to "billed" silently', () => {
    const result = validateCostScope({ costMetric: 'unblended', rules: [] });
    expect(result.costMetric).toBe('billed');
  });

  it('migrates costMetric "amortized" to "effective" silently', () => {
    const result = validateCostScope({ costMetric: 'amortized', rules: [] });
    expect(result.costMetric).toBe('effective');
  });

  it('migrates costMetric "blended" to "effective" silently', () => {
    const result = validateCostScope({ costMetric: 'blended', rules: [] });
    expect(result.costMetric).toBe('effective');
  });

  it('rejects truly unknown costMetric values', () => {
    expect(() => validateCostScope({ costMetric: 'nonsense', rules: [] })).toThrow(/costScope.costMetric must be one of/);
  });

  it('ignores and drops a legacy costPerspective key', () => {
    const result = validateCostScope({ costMetric: 'effective', costPerspective: 'net', rules: [] });
    expect(result.costMetric).toBe('effective');
    expect(Object.keys(result)).not.toContain('costPerspective');
  });

  it('migrates CUR-era dimension ids in rule conditions (user rules included)', () => {
    // Without the rename a user rule on a retired dim silently no-ops at
    // query time — or, in a multi-condition rule, drops one AND-leg and
    // excludes MORE than the user asked for.
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [{
        id: 'my-rule', name: 'Exclude EC2 credits', enabled: true,
        conditions: [
          { dimensionId: 'line_item_type', values: ['Credit'] },
          { dimensionId: 'service_family', values: ['Compute'] },
          { dimensionId: 'usage_type', values: ['BoxUsage'] },
          { dimensionId: 'tag_user_team', values: ['platform'] },
          { dimensionId: 'service', values: ['Amazon EC2'] },
        ],
      }],
    });
    expect(result.rules[0]?.conditions.map(c => c.dimensionId)).toEqual([
      'charge_category', 'service_category', 'sku_meter', 'tag_team', 'service',
    ]);
  });

  it('migrates the CUR-era marketplace attribution target AmazonBedrock to the ServiceName value', () => {
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [],
      marketplaceAttribution: {
        enabled: true,
        rules: [{ service: 'AmazonBedrock', operations: ['InvokeModelInference'] }],
      },
    });
    expect(result.marketplaceAttribution?.rules[0]?.service).toBe('Amazon Bedrock');
  });

  it('leaves non-legacy marketplace attribution targets untouched', () => {
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [],
      marketplaceAttribution: {
        enabled: true,
        rules: [{ service: 'My Private Marketplace Thing', operations: ['SomeOp'] }],
      },
    });
    expect(result.marketplaceAttribution?.rules[0]?.service).toBe('My Private Marketplace Thing');
  });
});

describe('marketplace attribution: SQL rewrite', () => {
  const bedrock = DEFAULT_MARKETPLACE_ATTRIBUTION;
  const matchPred = "COALESCE(x_ServiceCode, '') = '' AND x_Operation IN ('InvokeModelInference', 'InvokeModelStreamingInference')";

  it('re-attributes matched empty-servicecode rows to the target service', () => {
    const sql = buildQuery({ costMetric: 'effective', rules: [], marketplaceAttribution: bedrock });
    expect(sql).toContain(`CASE WHEN ${matchPred} THEN 'Amazon Bedrock' ELSE COALESCE(ServiceName, '') END AS service`);
  });

  it('leaves service untouched when disabled', () => {
    const sql = buildQuery({ costMetric: 'effective', rules: [], marketplaceAttribution: { enabled: false, rules: bedrock.rules } });
    expect(sql).toContain("COALESCE(ServiceName, '') AS service");
    expect(sql).not.toContain('Amazon Bedrock');
  });

  it('leaves service untouched when no costScope is supplied', () => {
    const sql = buildQuery();
    expect(sql).toContain("COALESCE(ServiceName, '') AS service");
    expect(sql).not.toContain('Amazon Bedrock');
  });

  it('substitutes billed cost for the $0 list price on the list metric', () => {
    const sql = buildQuery({ costMetric: 'list', rules: [], marketplaceAttribution: bedrock });
    expect(sql).toContain(`CASE WHEN ${matchPred} THEN COALESCE(BilledCost, 0) ELSE COALESCE(ListCost, 0) END AS cost`);
  });

  it('does NOT rewrite cost on billed (the real charge is already there)', () => {
    const sql = buildQuery({ costMetric: 'billed', rules: [], marketplaceAttribution: bedrock });
    expect(sql).toContain('COALESCE(BilledCost, 0) AS cost');
    expect(sql).not.toContain('END AS cost');
  });
});

describe('validateCostScope: marketplace attribution', () => {
  it('defaults to the shipped enabled rule when the block is absent', () => {
    const r = validateCostScope({ costMetric: 'effective', rules: [] });
    expect(r.marketplaceAttribution).toEqual(DEFAULT_MARKETPLACE_ATTRIBUTION);
  });

  it('honors an explicit disabled block (opt-out)', () => {
    const r = validateCostScope({ costMetric: 'effective', rules: [], marketplaceAttribution: { enabled: false, rules: [] } });
    expect(r.marketplaceAttribution).toEqual({ enabled: false, rules: [] });
  });

  it('rejects a rule with no operations', () => {
    expect(() => validateCostScope({
      costMetric: 'effective', rules: [],
      marketplaceAttribution: { enabled: true, rules: [{ service: 'X', operations: [] }] },
    })).toThrow(/operations must have at least one/);
  });

  it('rejects a rule with an empty service', () => {
    expect(() => validateCostScope({
      costMetric: 'effective', rules: [],
      marketplaceAttribution: { enabled: true, rules: [{ service: '', operations: ['Op'] }] },
    })).toThrow(/service must be a non-empty/);
  });

  it('round-trips through YAML serialization', () => {
    const cfg = validateCostScope({ costMetric: 'effective', rules: [] });
    expect(validateCostScope(costScopeToYaml(cfg))).toEqual(cfg);
  });
});

describe('buildDailyCostsQuery with costScope', () => {
  it('injects exclusion clause in daily costs query', () => {
    const { sql, params } = buildDailyCostsQuery(
      { ...baseParams, granularity: 'daily' },
      { dataDir: '/data', dimensions, providers: [{ name: PROVIDER }], costScope: {
        costMetric: 'billed',
        rules: [{ id: 'support', name: 'Support', enabled: true, builtIn: true, conditions: [{ dimensionId: asDimensionId('service_code'), values: ['AWSSupportEnterprise'] }] }],
      } },
    );
    // Single-condition rules use merged NOT IN form
    expect(sql).toContain('service_code NOT IN ($');
    expect(params).toContain('AWSSupportEnterprise');
    expect(sql).toContain('BilledCost');
  });
});

describe('validateCostScope: hostile config values (prototype-named keys)', () => {
  // Config files are git-shareable and reach validateCostScope from sharing
  // bundles too — a key colliding with an Object.prototype member must never
  // surface the inherited value (a Function here would crash sqlEscapeString
  // in every query build).
  it('keeps a marketplace target literally named "constructor" as the string', () => {
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [],
      marketplaceAttribution: {
        enabled: true,
        rules: [{ service: 'constructor', operations: ['SomeOp'] }],
      },
    });
    expect(result.marketplaceAttribution?.rules[0]?.service).toBe('constructor');
    expect(typeof result.marketplaceAttribution?.rules[0]?.service).toBe('string');
  });

  it('keeps a marketplace target literally named "__proto__" as the string', () => {
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [],
      marketplaceAttribution: {
        enabled: true,
        rules: [{ service: '__proto__', operations: ['SomeOp'] }],
      },
    });
    expect(result.marketplaceAttribution?.rules[0]?.service).toBe('__proto__');
  });

  it('rejects a costMetric named after an Object.prototype member instead of surfacing it', () => {
    expect(() => validateCostScope({ costMetric: 'hasOwnProperty', rules: [] }))
      .toThrow(/costScope.costMetric must be one of/);
  });

  it('passes a dimensionId named after an Object.prototype member through unrenamed', () => {
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [{ id: 'r', name: 'r', enabled: true, conditions: [{ dimensionId: 'constructor', values: ['x'] }] }],
    });
    expect(result.rules[0]?.conditions[0]?.dimensionId).toBe('constructor');
  });
});

describe('validateCostScope: live dimension ids gate the CUR-era renames', () => {
  // A FOCUS-era tag key like `user:CostCenter` sanitizes to the dimension id
  // `tag_user_CostCenter` — the same shape as a CUR-era leftover. Callers
  // that know the current dimensions pass them so live ids are never
  // misrenamed (which would fail every save via assertRuleDimensionsExist
  // and silently drop the condition at query time).
  it('preserves a live tag_user_* dimension id', () => {
    const live = new Set(['tag_user_CostCenter']);
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [{ id: 'r', name: 'r', enabled: true, conditions: [{ dimensionId: 'tag_user_CostCenter', values: ['123'] }] }],
    }, live);
    expect(result.rules[0]?.conditions[0]?.dimensionId).toBe('tag_user_CostCenter');
  });

  it('still renames CUR-era tag_user_* ids absent from the live set', () => {
    const live = new Set(['tag_user_CostCenter']);
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [{ id: 'r', name: 'r', enabled: true, conditions: [{ dimensionId: 'tag_user_team', values: ['platform'] }] }],
    }, live);
    expect(result.rules[0]?.conditions[0]?.dimensionId).toBe('tag_team');
  });

  it('exempts a live dimension whose id collides with a direct CUR rename', () => {
    const live = new Set(['line_item_type']);
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [{ id: 'r', name: 'r', enabled: true, conditions: [{ dimensionId: 'line_item_type', values: ['Tax'] }] }],
    }, live);
    expect(result.rules[0]?.conditions[0]?.dimensionId).toBe('line_item_type');
  });

  it('renames as before when no live set is supplied', () => {
    const result = validateCostScope({
      costMetric: 'effective',
      rules: [{ id: 'r', name: 'r', enabled: true, conditions: [{ dimensionId: 'tag_user_team', values: ['platform'] }] }],
    });
    expect(result.rules[0]?.conditions[0]?.dimensionId).toBe('tag_team');
  });
});
