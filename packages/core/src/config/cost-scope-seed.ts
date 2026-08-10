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
        // Match by exact service code (x_ServiceCode), not ServiceName or
        // ServiceCategory: display names vary across AWS revisions and the
        // standardized categories group support with other management
        // charges. The three AWSSupport* codes are the authoritative
        // premium-support line items.
        dimensionId: asDimensionId('service_code'),
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
      { dimensionId: asDimensionId('charge_category'), values: ['Tax'] },
    ],
  },
];

/** Built-in rule IDs that have been removed since older configs were written.
 *  Loaded configs may still carry them; the merge step drops them silently and
 *  may migrate other fields (see mergeBuiltInExclusionRules) to preserve the
 *  spirit of the user's prior choice. */
/** The exact CUR-era seed conditions of surviving built-in rules
 *  (JSON-serialized for shape equality). Persisted conditions matching one
 *  of these are provably the untouched old default — safe to swap for the
 *  new seed's conditions. Anything else on a built-in rule is a user edit
 *  and is kept. Each entry may list several spellings: the raw on-disk
 *  CUR-era form and the form after validateCostScope's dimension-id
 *  migration (builtin:tax's migrated form equals the new seed, so only its
 *  raw form appears; the premium-support `service` id is unrenamed, so its
 *  two forms coincide). */
const LEGACY_SEED_CONDITIONS: Readonly<Record<string, readonly string[]>> = {
  'builtin:aws-premium-support': [
    JSON.stringify([
      { dimensionId: 'service', values: ['AWSSupportEnterprise', 'AWSSupportBusiness', 'AWSSupportDeveloper'] },
    ]),
  ],
  'builtin:tax': [
    JSON.stringify([{ dimensionId: 'line_item_type', values: ['Tax'] }]),
  ],
};

const RETIRED_BUILTIN_RULE_IDS: ReadonlySet<string> = new Set([
  // Subsumed by the `list` cost metric — when that metric is selected, the
  // query layer auto-filters to usage rows the same way this rule used to.
  'builtin:ri-sp-purchases',
  // Removed entirely: this was a savings-sizing tool, not a coherent
  // cost-scope toggle. Belongs in a dedicated commitment-coverage view.
  'builtin:commitment-covered-usage',
  // Retired with the FOCUS 1.2 migration: CUR's EdpDiscount/BundledDiscount
  // line item types have no FOCUS row equivalent — negotiated discounts are
  // netted into BilledCost/ContractedCost (with per-row detail in the
  // x_Discounts map) rather than appearing as standalone negative rows. Use
  // the `list` vs `contracted` metrics to see pre- vs post-negotiation cost.
  'builtin:edp-discount',
  'builtin:bundled-discount',
]);

/** Shipped Marketplace re-attribution. Bedrock third-party model inference is
 *  the one AWS "service" that consistently arrives as a blank-x_ServiceCode
 *  Marketplace row with no list price; Tax and commitment purchases are the
 *  other blank-servicecode populations and are intentionally NOT here (they're
 *  not per-service usage and the `list` metric already filters them out). */
export const DEFAULT_MARKETPLACE_ATTRIBUTION: MarketplaceAttributionConfig = {
  enabled: true,
  rules: [
    {
      service: 'Amazon Bedrock',
      operations: ['InvokeModelInference', 'InvokeModelStreamingInference'],
    },
  ],
};

export const DEFAULT_COST_SCOPE: CostScopeConfig = {
  costMetric: 'effective',
  rules: BUILTIN_EXCLUSION_RULES,
  marketplaceAttribution: DEFAULT_MARKETPLACE_ATTRIBUTION,
};

/** Merge shipped built-in rules into a loaded config. Mirrors
 *  mergeDefaultBuiltIns for dimensions: preserve user edits on existing
 *  built-ins, add any that are missing. User rules are untouched.
 *
 *  Also drops retired built-in rules (RETIRED_BUILTIN_RULE_IDS) silently.
 *  If the user had the retired `builtin:ri-sp-purchases` rule enabled, the
 *  metric is rewritten to `list` so the spirit of their choice (exclude
 *  commitment purchase rows) is preserved with the new coherent model.
 *
 *  Built-in rules' CONDITIONS are repaired when they still carry the exact
 *  CUR-era seed shape: the FOCUS migration moved premium support from the
 *  `service` dim (now ServiceName display names, where the AWSSupport* codes
 *  match nothing) to `service_code`, so the untouched old shape would
 *  silently no-op every query the rule should filter. The repair matches
 *  the legacy shape EXACTLY — user-edited conditions differ from it and are
 *  preserved (the Cost Scope UI supports editing built-in conditions and
 *  offers its own Reset-to-default affordance). */
export function mergeBuiltInExclusionRules(loaded: CostScopeConfig): CostScopeConfig {
  const retiredRiSpPurchasesEnabled = loaded.rules.some(
    r => r.id === 'builtin:ri-sp-purchases' && r.enabled,
  );

  const seedById = new Map(BUILTIN_EXCLUSION_RULES.map(b => [b.id, b]));
  const surviving = loaded.rules.filter(r => !RETIRED_BUILTIN_RULE_IDS.has(r.id));
  const survivingRules = surviving.map(r => {
    const seed = seedById.get(r.id);
    if (seed === undefined) return r;
    const legacyShapes = LEGACY_SEED_CONDITIONS[r.id];
    if (!legacyShapes?.includes(JSON.stringify(r.conditions))) return r;
    return { ...r, conditions: seed.conditions };
  });
  const refreshedAny = survivingRules.some((r, i) => r !== surviving[i]);
  const survivingIds = new Set(survivingRules.map(r => r.id));
  const missingBuiltins = BUILTIN_EXCLUSION_RULES.filter(b => !survivingIds.has(b.id));

  const droppedAny = surviving.length !== loaded.rules.length;
  if (!droppedAny && missingBuiltins.length === 0 && !retiredRiSpPurchasesEnabled && !refreshedAny) {
    return loaded;
  }

  const rules = [...survivingRules, ...missingBuiltins];
  const costMetric = retiredRiSpPurchasesEnabled ? 'list' : loaded.costMetric;
  return { ...loaded, costMetric, rules };
}
