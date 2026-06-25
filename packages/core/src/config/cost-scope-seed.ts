import { asDimensionId } from '../types/branded.js';
import type { CostScopeConfig, ExclusionRule, MarketplaceAttributionConfig } from '../types/cost-scope.js';

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
    id: 'builtin:negotiated-discounts',
    name: 'Negotiated discounts',
    description:
      'Standalone negative discount line items — the AWS Enterprise Discount Program (EdpDiscount, contractual volume discount) and automatic bundle-pricing rules (BundledDiscount, e.g. support-tier bundle credits). Both are separate rows, not paired with a specific usage line. Leave off to see the effective bill after these discounts; toggle on to view gross / pre-negotiation cost. Distinct from the Net perspective, which applies account-level credits and refunds.',
    enabled: false,
    builtIn: true,
    conditions: [
      { dimensionId: asDimensionId('line_item_type'), values: ['EdpDiscount', 'BundledDiscount'] },
    ],
  },
];

/** Built-in rule IDs that have been removed since older configs were written.
 *  Loaded configs may still carry them; the merge step drops them silently and
 *  may migrate other fields (see mergeBuiltInExclusionRules) to preserve the
 *  spirit of the user's prior choice. */
const RETIRED_BUILTIN_RULE_IDS: ReadonlySet<string> = new Set([
  // Subsumed by the `list` cost metric — when that metric is selected, the
  // query layer auto-filters the same line item types this rule used to.
  'builtin:ri-sp-purchases',
  // Removed entirely: this was a savings-sizing tool, not a coherent
  // cost-scope toggle. Belongs in a dedicated commitment-coverage view.
  'builtin:commitment-covered-usage',
  // Merged into `builtin:negotiated-discounts` — both excluded a single
  // standalone discount line-item type and only differed by which one.
  // mergeBuiltInExclusionRules enables the merged rule if either was on.
  'builtin:edp-discount',
  'builtin:bundled-discount',
]);

/** Shipped Marketplace re-attribution. Bedrock third-party model inference is
 *  the one AWS "service" that consistently arrives as a blank-product_servicecode
 *  Marketplace row with real cost only in unblended; Tax and RI/SP fees are the
 *  other blank-servicecode populations and are intentionally NOT here (they're
 *  not per-service usage and the `list` metric already filters fee rows out). */
export const DEFAULT_MARKETPLACE_ATTRIBUTION: MarketplaceAttributionConfig = {
  enabled: true,
  rules: [
    {
      service: 'AmazonBedrock',
      operations: ['InvokeModelInference', 'InvokeModelStreamingInference'],
    },
  ],
};

export const DEFAULT_COST_SCOPE: CostScopeConfig = {
  costMetric: 'unblended',
  rules: BUILTIN_EXCLUSION_RULES,
  marketplaceAttribution: DEFAULT_MARKETPLACE_ATTRIBUTION,
};

/** Merge shipped built-in rules into a loaded config. Mirrors
 *  mergeDefaultBuiltIns for dimensions: preserve user edits on existing
 *  built-ins, add any that are missing. User rules are untouched.
 *
 *  Also drops retired built-in rules (RETIRED_BUILTIN_RULE_IDS) silently —
 *  these were superseded by the `list` cost metric. If the user had the
 *  retired `builtin:ri-sp-purchases` rule enabled, the metric is rewritten
 *  to `list` so the spirit of their choice (exclude RI/SP fee rows) is
 *  preserved with the new coherent model. */
export function mergeBuiltInExclusionRules(loaded: CostScopeConfig): CostScopeConfig {
  const retiredRiSpPurchasesEnabled = loaded.rules.some(
    r => r.id === 'builtin:ri-sp-purchases' && r.enabled,
  );
  // The EDP and Bundled discount rules were merged into a single
  // `builtin:negotiated-discounts`. Carry the user's intent forward: if
  // either legacy rule was enabled, enable the merged rule (added below as a
  // missing built-in, since loaded configs predate it).
  const retiredDiscountEnabled = loaded.rules.some(
    r => (r.id === 'builtin:edp-discount' || r.id === 'builtin:bundled-discount') && r.enabled,
  );

  const survivingRules = loaded.rules.filter(r => !RETIRED_BUILTIN_RULE_IDS.has(r.id));
  const survivingIds = new Set(survivingRules.map(r => r.id));
  const missingBuiltins = BUILTIN_EXCLUSION_RULES.filter(b => !survivingIds.has(b.id)).map(b =>
    b.id === 'builtin:negotiated-discounts' && retiredDiscountEnabled ? { ...b, enabled: true } : b,
  );

  const droppedAny = survivingRules.length !== loaded.rules.length;
  if (!droppedAny && missingBuiltins.length === 0 && !retiredRiSpPurchasesEnabled) {
    return loaded;
  }

  const rules = [...survivingRules, ...missingBuiltins];
  const costMetric = retiredRiSpPurchasesEnabled ? 'list' : loaded.costMetric;
  return { ...loaded, costMetric, rules };
}
