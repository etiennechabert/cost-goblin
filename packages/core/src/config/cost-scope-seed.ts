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
  // Folded into the `discountTreatment` axis ('excluded'). EDP and Bundled
  // discounts (and the interim merged `builtin:negotiated-discounts` rule) are
  // no longer exclusion rules; mergeBuiltInExclusionRules infers the treatment
  // from whether any of these was enabled, then drops them.
  'builtin:edp-discount',
  'builtin:bundled-discount',
  'builtin:negotiated-discounts',
]);

/** Legacy discount-exclusion rule ids whose "enabled" state, on an older
 *  config that hasn't yet picked a `discountTreatment`, means "show
 *  pre-negotiation cost" → maps to the `excluded` treatment. */
const LEGACY_DISCOUNT_RULE_IDS: ReadonlySet<string> = new Set([
  'builtin:edp-discount',
  'builtin:bundled-discount',
  'builtin:negotiated-discounts',
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
 *  Also drops retired built-in rules (RETIRED_BUILTIN_RULE_IDS) silently and
 *  migrates the user's intent to the replacement model:
 *   - retired `builtin:ri-sp-purchases` enabled → rewrite the metric to `list`
 *     (which auto-filters the same RI/SP fee rows).
 *   - retired discount rules (EDP / Bundled / interim merged) enabled, when the
 *     config hasn't already picked a `discountTreatment` → set `excluded`
 *     (show pre-negotiation cost), preserving the old toggle's meaning. */
export function mergeBuiltInExclusionRules(loaded: CostScopeConfig): CostScopeConfig {
  const retiredRiSpPurchasesEnabled = loaded.rules.some(
    r => r.id === 'builtin:ri-sp-purchases' && r.enabled,
  );
  const legacyDiscountEnabled = loaded.rules.some(
    r => LEGACY_DISCOUNT_RULE_IDS.has(r.id) && r.enabled,
  );

  const survivingRules = loaded.rules.filter(r => !RETIRED_BUILTIN_RULE_IDS.has(r.id));
  const survivingIds = new Set(survivingRules.map(r => r.id));
  const missingBuiltins = BUILTIN_EXCLUSION_RULES.filter(b => !survivingIds.has(b.id));

  // An explicit treatment on disk always wins; only infer `excluded` for legacy
  // configs that never had the axis but had a discount rule switched on.
  const discountTreatment = loaded.discountTreatment ?? (legacyDiscountEnabled ? 'excluded' : undefined);

  const droppedAny = survivingRules.length !== loaded.rules.length;
  const treatmentChanged = discountTreatment !== loaded.discountTreatment;
  if (!droppedAny && missingBuiltins.length === 0 && !retiredRiSpPurchasesEnabled && !treatmentChanged) {
    return loaded;
  }

  const rules = [...survivingRules, ...missingBuiltins];
  const costMetric = retiredRiSpPurchasesEnabled ? 'list' : loaded.costMetric;
  return {
    ...loaded,
    costMetric,
    ...(discountTreatment === undefined ? {} : { discountTreatment }),
    rules,
  };
}
