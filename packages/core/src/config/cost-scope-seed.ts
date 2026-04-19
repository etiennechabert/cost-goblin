import { asDimensionId } from '../types/branded.js';
import type { CostScopeConfig, ExclusionRule } from '../types/cost-scope.js';

export const BUILTIN_EXCLUSION_RULES: readonly ExclusionRule[] = [
  {
    id: 'builtin:aws-premium-support',
    name: 'AWS Premium Support',
    description:
      'AWS Enterprise / Business / Developer support subscription fees. Flat-rate monthly billing outside per-resource usage.',
    enabled: false,
    builtIn: true,
    conditions: [
      {
        // Match by service code, not service_family. `Support` as a
        // product_family groups in things some users don't consider
        // premium support (e.g. some training / API-call support lines),
        // and isn't populated consistently across CUR revisions. The
        // three AWSSupport* service codes are the authoritative
        // premium-support line items.
        dimensionId: asDimensionId('service'),
        values: ['AWSSupportEnterprise', 'AWSSupportBusiness', 'AWSSupportDeveloper'],
      },
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
  {
    id: 'builtin:bundled-discount',
    name: 'Bundled discount',
    description:
      'Negative discount line items applied automatically by AWS bundle pricing rules (e.g. support-tier bundle credits). Like EDP, standalone — not paired with a specific usage row. Toggle on to see pre-bundle cost.',
    enabled: false,
    builtIn: true,
    conditions: [
      { dimensionId: asDimensionId('line_item_type'), values: ['BundledDiscount'] },
    ],
  },
  {
    id: 'builtin:commitment-covered-usage',
    name: 'RI & SP covered usage',
    description:
      'Usage already covered by a Reserved Instance (DiscountedUsage) or Savings Plan (SavingsPlanCoveredUsage paired with SavingsPlanNegation). Toggle on to isolate on-demand spend — the workloads NOT yet covered by a commitment. SP negation is bundled so its discount does not leak when the usage it offsets is removed.',
    enabled: false,
    builtIn: true,
    conditions: [
      {
        dimensionId: asDimensionId('line_item_type'),
        values: ['DiscountedUsage', 'SavingsPlanCoveredUsage', 'SavingsPlanNegation'],
      },
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
