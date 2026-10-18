import { describe, expect, it } from 'vitest';
import { costScopeToYaml } from '../config/cost-scope-serialize.js';
import { validateCostScope } from '../config/cost-scope-validator.js';
import { asDimensionId } from '../types/branded.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';
import { DEFAULT_LAG_DAYS } from '../types/cost-scope.js';

const untagged: ExclusionRule = {
  id: 'user:untagged',
  name: 'Untagged EC2',
  description: 'EC2 rows nobody owns',
  enabled: true,
  builtIn: false,
  conditions: [
    { dimensionId: asDimensionId('tag_team'), values: [], matchMissing: true },
    { dimensionId: asDimensionId('service'), values: ['Amazon EC2'] },
  ],
};

const tax: ExclusionRule = {
  id: 'builtin:tax',
  name: 'Tax',
  enabled: false,
  builtIn: true,
  conditions: [{ dimensionId: asDimensionId('charge_category'), values: ['Tax'], matchMissing: false }],
};

const full: CostScopeConfig = {
  costMetric: 'list',
  lagDays: 0,
  rules: [untagged, tax],
  marketplaceAttribution: { enabled: true, rules: [{ service: 'Amazon Bedrock', operations: ['InvokeModelInference', 'InvokeModelStreamingInference'] }] },
};

describe('costScopeToYaml', () => {
  it('writes every field of a fully-specified scope', () => {
    expect(costScopeToYaml(full)).toStrictEqual({
      costMetric: 'list',
      lagDays: 0,
      rules: [
        {
          id: 'user:untagged',
          name: 'Untagged EC2',
          description: 'EC2 rows nobody owns',
          enabled: true,
          builtIn: false,
          conditions: [
            { dimensionId: 'tag_team', values: [], matchMissing: true },
            { dimensionId: 'service', values: ['Amazon EC2'] },
          ],
        },
        // No description key, and matchMissing written only when true.
        { id: 'builtin:tax', name: 'Tax', enabled: false, builtIn: true, conditions: [{ dimensionId: 'charge_category', values: ['Tax'] }] },
      ],
      marketplaceAttribution: { enabled: true, rules: [{ service: 'Amazon Bedrock', operations: ['InvokeModelInference', 'InvokeModelStreamingInference'] }] },
    });
  });

  it('writes keys in a stable order', () => {
    expect(Object.keys(costScopeToYaml(full))).toEqual(['costMetric', 'lagDays', 'rules', 'marketplaceAttribution']);
  });

  it('leaves out lag days at the default, whether implicit or explicit, and the absent marketplace block', () => {
    expect(costScopeToYaml({ costMetric: 'effective', rules: [] })).toStrictEqual({ costMetric: 'effective', rules: [] });
    expect(costScopeToYaml({ costMetric: 'effective', rules: [], lagDays: DEFAULT_LAG_DAYS })).toStrictEqual({ costMetric: 'effective', rules: [] });
  });

  it('writes a non-default lag days value', () => {
    expect(costScopeToYaml({ costMetric: 'billed', rules: [], lagDays: 5 })).toStrictEqual({ costMetric: 'billed', lagDays: 5, rules: [] });
  });

  it('writes a disabled marketplace block with its rules', () => {
    expect(costScopeToYaml({ costMetric: 'billed', rules: [], marketplaceAttribution: { enabled: false, rules: [] } }))
      .toStrictEqual({ costMetric: 'billed', rules: [], marketplaceAttribution: { enabled: false, rules: [] } });
  });

  it('copies value and operation lists rather than sharing them', () => {
    const yaml = costScopeToYaml(full);
    expect(yaml.rules[0]?.conditions[1]?.values).not.toBe(untagged.conditions[1]?.values);
    expect(yaml.marketplaceAttribution?.rules[0]?.operations).not.toBe(full.marketplaceAttribution?.rules[0]?.operations);
  });

  it('round-trips through validateCostScope', () => {
    const cfg: CostScopeConfig = { ...full, lagDays: 7, rules: [untagged] };
    expect(validateCostScope(costScopeToYaml(cfg))).toStrictEqual(cfg);
  });
});
