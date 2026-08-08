/** Default built-in dimensions and the merge that reconciles a loaded
 *  dimensions.yaml against them. Kept in its own module (no electron imports)
 *  so the merge logic is unit-testable without booting the main process. */

import { asDimensionId, LEGACY_DIMENSION_ID_RENAMES } from '@costgoblin/core';
import type { BuiltInDimension, DimensionsConfig } from '@costgoblin/core';
import { PROVIDER_ABSENT_DIMENSIONS, type TemplateProviderType } from '../config-templates.js';

export const DEFAULT_BUILT_INS: readonly BuiltInDimension[] = [
  // Injected at read time by buildSource (constant column per provider
  // branch) — never stored in Parquet. With several same-type providers this
  // is the payer/billing-source axis.
  { name: asDimensionId('provider'), label: 'Provider', field: 'provider', description: 'Which configured billing source the cost came from. With multiple payer accounts, this is the payer axis.' },
  { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name', description: 'AWS account the cost was charged to. Main axis for org/team-level rollups.', useOrgAccounts: true },
  { name: asDimensionId('region'), label: 'Region', field: 'region', description: 'AWS region where the resource ran. Useful for spotting unintended multi-region sprawl.', useRegionNames: true },
  // Two pure-enrichment dims derived from the same `region` column: Country
  // and Continent group multiple regions into geo buckets via SSM metadata.
  // Off by default — not everyone needs geo rollups, and without an SSM sync
  // they'd just mirror the Region dim.
  { name: asDimensionId('region_country'), label: 'Country', field: 'region', description: 'ISO country code derived from the region (DE, US, IE). Useful for data-residency and geo chargeback.', enabled: false },
  { name: asDimensionId('region_continent'), label: 'Continent', field: 'region', description: 'AWS geographic bucket (EU, NA, AS) derived from the region. Useful for continent-level summaries.', enabled: false },
  { name: asDimensionId('service'), label: 'Service', field: 'service', description: 'Service the cost came from (FOCUS ServiceName, e.g. "Amazon Simple Storage Service") — the broadest "what cost me this?" view.' },
  // Exact provider service code (x_ServiceCode, e.g. AmazonS3). Off by
  // default — the display-name Service dim covers browsing; this one exists
  // for exact-code filters and the built-in premium-support exclusion rule.
  { name: asDimensionId('service_code'), label: 'Service Code', field: 'service_code', description: 'Exact AWS service code (AmazonEC2, AmazonS3). Use for precise filters where display names are ambiguous.', enabled: false },
  { name: asDimensionId('service_category'), label: 'Service Category', field: 'service_category', description: 'Standardized FOCUS category (Compute, Storage, Databases — ~13 values, identical across cloud providers). Good for exec summaries.' },
  { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category', description: 'Usage vs Purchase vs Tax vs Credit vs Adjustment. Filter this to isolate real usage from billing events.' },
  { name: asDimensionId('pricing_category'), label: 'Pricing Category', field: 'pricing_category', description: 'How the usage was priced: Standard (on-demand), Committed (RI/SP-covered), Dynamic (spot). Spot commitment coverage at a glance.', enabled: false },
  { name: asDimensionId('commitment_status'), label: 'Commitment Status', field: 'commitment_status', description: 'Used vs Unused commitment (RI/SP) cost. Filter to Unused to see commitment waste.', enabled: false },
  { name: asDimensionId('sku_meter'), label: 'SKU Meter', field: 'sku_meter', description: 'Fine-grained usage meter like EUC1-Requests-Tier2 (the CUR usage-type equivalent). Use for instance/storage-tier breakdowns.', enabled: false },
  { name: asDimensionId('operation'), label: 'Operation', field: 'operation', description: 'API operation billed for (RunInstances, GetObject). Useful for API-level cost attribution.', enabled: false },
  // Very high cardinality — disabled by default so the normal filter/nav
  // pickers stay scannable. The Explorer references it directly so
  // click-to-filter on a resource cell works whether or not this dim is
  { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', description: 'AWS resource ID or ARN (i-0abc…, arn:aws:rds:…). High-cardinality — useful for drilling into specific resources.' },
];

/** Renames we want propagated to existing configs. Only overrides the stored
 *  label when it still matches the previous default — if the user had typed
 *  their own label we leave it alone. */
const LEGACY_LABEL_RENAMES: Record<string, { from: string; to: string }> = {
  service: { from: 'AWS Service', to: 'Service' },
};

/** Built-in dims whose backing canonical column was removed by the FOCUS 1.2
 *  migration (#515). A loaded config still carrying one would emit SQL
 *  against a nonexistent column and binder-error every query, so they are
 *  dropped at merge time; their FOCUS replacements arrive via
 *  DEFAULT_BUILT_INS (`missing` below). Derived from the legacy rename map
 *  so the two can't drift: every renamed id is exactly a retired column. */
const RETIRED_BUILTIN_DIM_NAMES: ReadonlySet<string> = new Set(
  Object.keys(LEGACY_DIMENSION_ID_RENAMES),
);

/** True when a default dimension cannot be populated by ANY configured
 *  provider — every provider type in the workspace lists it absent. Those are
 *  the dims the wizard omits; the merge must not resurrect them or a GCP-only
 *  workspace gets a group-by that renders one blank value for 100% of spend.
 *  With no providers configured (fresh install) nothing is skipped. A mixed
 *  workspace keeps the dim because at least one provider can fill it. */
function isAbsentForAllProviders(name: string, providerTypes: readonly TemplateProviderType[]): boolean {
  return providerTypes.length > 0
    && providerTypes.every(t => PROVIDER_ABSENT_DIMENSIONS[t].has(name));
}

export function mergeDefaultBuiltIns(
  loaded: DimensionsConfig,
  providerTypes: readonly TemplateProviderType[],
): DimensionsConfig {
  const defaultsByName = new Map(DEFAULT_BUILT_INS.map(d => [d.name, d]));
  // Backfill description on existing entries for any default whose config
  // predates the description field. User-set fields (label, aliases, etc.)
  // are kept — we only fill a missing description.
  // Also backfill useRegionNames=true on the Region dim so pre-existing
  // configs don't regress from friendly names back to raw codes now that the
  // alias injection is gated on this flag.
  const surviving = loaded.builtIn.filter(d => !RETIRED_BUILTIN_DIM_NAMES.has(String(d.name)));
  const backfilled = surviving.map(d => {
    let next = d;
    const rename = LEGACY_LABEL_RENAMES[d.name];
    if (rename?.from === next.label) {
      next = { ...next, label: rename.to };
    }
    if (next.description === undefined) {
      const def = defaultsByName.get(next.name);
      if (def?.description !== undefined) next = { ...next, description: def.description };
    }
    // Only the plain Region dim — Country/Continent share field='region' but
    // their own enrichment branches by name, so useRegionNames would be a
    // meaningless setting on them (and would pollute the saved YAML).
    if (next.name === 'region' && next.useRegionNames === undefined) {
      next = { ...next, useRegionNames: true };
    }
    return next;
  });
  const have = new Set(backfilled.map(d => d.name));
  // Skip re-adding a default that no configured provider can populate — this
  // is what keeps the GCP wizard's omission of service_category/operation/
  // sku_meter from being silently undone on the next load.
  const missing = DEFAULT_BUILT_INS.filter(
    d => !have.has(d.name) && !isAbsentForAllProviders(String(d.name), providerTypes),
  );
  const changed = surviving.length !== loaded.builtIn.length
    || backfilled.some((d, i) => d !== surviving[i]);
  if (missing.length === 0 && !changed) return loaded;
  return {
    builtIn: [...backfilled, ...missing],
    tags: loaded.tags,
    ...(loaded.order === undefined ? {} : { order: loaded.order }),
  };
}
