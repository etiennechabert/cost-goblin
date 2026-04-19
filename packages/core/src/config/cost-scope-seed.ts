import { asDimensionId } from '../types/branded.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';

export const BUILTIN_EXCLUSION_RULES: readonly ExclusionRule[] = [
  {
    id: 'builtin:aws-premium-support',
    name: 'AWS Premium Support',
    description:
      'AWS Enterprise / Business / Developer support subscription fees. Usually a flat line item outside per-resource usage.',
    enabled: false,
    builtIn: true,
    conditions: [
      { dimensionId: asDimensionId('service_family'), values: ['Support'] },
    ],
  },
  {
    id: 'builtin:ri-sp-purchases',
    name: 'RI & Savings Plan purchases',
    description:
      'Upfront/recurring fees for Reserved Instances and Savings Plans, plus SP negation adjustments. RI/SP-covered usage still appears under DiscountedUsage / SavingsPlanCoveredUsage and is not affected by this rule.',
    enabled: false,
    builtIn: true,
    conditions: [
      {
        dimensionId: asDimensionId('line_item_type'),
        values: ['RIFee', 'SavingsPlanRecurringFee', 'SavingsPlanUpfrontFee', 'SavingsPlanNegation'],
      },
    ],
  },
  {
    id: 'builtin:tax',
    name: 'Tax',
    description:
      'VAT / GST / sales-tax line items. Toggle on to compare pre-tax run-rate across regions or exclude tax from forecasts; leave off to see the all-in bill.',
    enabled: false,
    builtIn: true,
    conditions: [
      { dimensionId: asDimensionId('line_item_type'), values: ['Tax'] },
    ],
  },
  {
    id: 'builtin:edp-discount',
    name: 'EDP discount',
    description:
      'Negative line items from the AWS Enterprise Discount Program (contractual volume discount). Toggle on to view gross / pre-negotiation cost; leave off to see the effective bill after the EDP credit.',
    enabled: false,
    builtIn: true,
    conditions: [
      { dimensionId: asDimensionId('line_item_type'), values: ['EdpDiscount'] },
    ],
  },
];

export const DEFAULT_COST_SCOPE: CostScopeConfig = {
  costMetric: 'unblended',
  rules: BUILTIN_EXCLUSION_RULES,
};

/** Merge shipped built-in rules into a loaded config. Mirrors
 *  mergeDefaultBuiltIns for dimensions: preserve user edits on existing
 *  built-ins, add any that are missing. User rules are untouched. */
export function mergeBuiltInExclusionRules(loaded: CostScopeConfig): CostScopeConfig {
  const loadedById = new Map(loaded.rules.map(r => [r.id, r]));
  const missingBuiltins = BUILTIN_EXCLUSION_RULES.filter(b => !loadedById.has(b.id));
  if (missingBuiltins.length === 0) return loaded;
  return { ...loaded, rules: [...loaded.rules, ...missingBuiltins] };
}
