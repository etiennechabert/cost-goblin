import type { DimensionId } from './branded.js';

/** Which cost perspective backs the `cost` alias in every query.
 *  - `unblended`  — what you were actually billed; upfront RI/SP fees land
 *                   as a lump in their month.
 *  - `amortized`  — spreads RI/SP upfront payments over their term and uses
 *                   effective cost for covered usage. Best for run-rate and
 *                   forecasting.
 *  - `list`       — hypothetical on-demand list price (`pricing_public_on_demand_cost`),
 *                   ignoring all RI/SP discounts. Not money actually spent;
 *                   shows what usage would have cost without commitments.
 *                   When selected, queries are automatically restricted to
 *                   usage-bearing line items (`Usage`, `SavingsPlanCoveredUsage`,
 *                   `DiscountedUsage`) because RI/SP fee rows have no list price.
 *
 *  AWS's `blended` (consolidated-billing weighted-average) metric was
 *  intentionally NOT shipped: AWS never extended blended math to Savings
 *  Plans, so on any modern SP-based fleet it's nearly indistinguishable
 *  from unblended and ships none of the chargeback fairness it was
 *  originally designed for. Users on legacy configs with
 *  `costMetric: 'blended'` are silently migrated to `'amortized'` at load
 *  time (see cost-scope-validator.ts).
 *
 *  The SQL expression that each value resolves to lives in
 *  packages/core/src/query/cost-metric.ts. */
export type CostMetric = 'unblended' | 'amortized' | 'list';

export const COST_METRICS: readonly CostMetric[] = ['unblended', 'amortized', 'list'] as const;

/** Low-level cost-column selector: gross uses the as-billed
 *  `*_unblended_cost` columns; net uses the `*_net_*` columns, which fold each
 *  negotiated discount into the line that earned it. Not a user-facing setting
 *  any more — it's DERIVED from {@link DiscountTreatment} (see
 *  config/discount-treatment.ts). Still threaded directly through the query
 *  builder, the rollup signature, and the Explorer's per-view override. When
 *  net columns are missing, `costExprFor` falls back to gross. */
export type CostPerspective = 'gross' | 'net';

export const COST_PERSPECTIVES: readonly CostPerspective[] = ['gross', 'net'] as const;

/** How negotiated AWS discounts are reflected in every query. AWS books the
 *  Enterprise Discount Program (EDP) volume discount and automatic bundled
 *  discounts in two interchangeable ways, and this single axis picks between
 *  them — replacing the former gross/net "perspective" toggle PLUS the
 *  standalone EDP / Bundled exclusion rules. Those two controls together
 *  produced four states but only three distinct outcomes (net already folds
 *  the discount in, so excluding it on top was a no-op).
 *   - `spread`   — AWS net columns: each negotiated discount is folded into the
 *                  service / usage line that earned it, so per-service cost is
 *                  discount-accurate. The real bill, attributed. Best for
 *                  chargeback (what Cost Explorer shows).
 *   - `itemized` — gross columns: the discount stays as its own standalone
 *                  negative line item, unattributed. Bill total is identical to
 *                  `spread`, but no individual service shows its discounted rate.
 *   - `excluded` — gross columns with the `EdpDiscount` / `BundledDiscount` rows
 *                  removed: pre-negotiation "rack rate". NOT money you paid.
 *
 *  Derivation to the low-level {@link CostPerspective} + the synthetic
 *  negotiated-discount exclusion lives in config/discount-treatment.ts. */
export type DiscountTreatment = 'spread' | 'itemized' | 'excluded';

export const DISCOUNT_TREATMENTS: readonly DiscountTreatment[] = ['spread', 'itemized', 'excluded'] as const;

/** Gross columns with the discount left as a standalone line item — preserves
 *  the historic default (old `gross` perspective + EDP/Bundled rules disabled),
 *  so totals and attribution don't shift for existing installs on upgrade. */
export const DEFAULT_DISCOUNT_TREATMENT: DiscountTreatment = 'itemized';

/** One AND-ed condition inside an exclusion rule. Matches when the row's
 *  value for `dimensionId` is in `values` (OR within values). Empty `values`
 *  is invalid — reject it in the validator. */
export interface ExclusionCondition {
  readonly dimensionId: DimensionId;
  readonly values: readonly string[];
}

export interface ExclusionRule {
  /** Stable id. Built-ins use `builtin:<slug>`; user rules get a uuid-v4
   *  minted by the UI on creation. */
  readonly id: string;
  /** User-editable. For built-ins, on-disk name is preferred so edits stick. */
  readonly name: string;
  /** Free-form. Optional. */
  readonly description?: string | undefined;
  /** When false, the rule has no effect on queries. */
  readonly enabled: boolean;
  /** True for rules shipped with the app. Cannot be deleted, only toggled. */
  readonly builtIn: boolean;
  /** AND-ed conditions. At least one condition; each condition has at least
   *  one value. Enforced by the validator. */
  readonly conditions: readonly ExclusionCondition[];
}

/** One re-attribution rule for AWS Marketplace line items. AWS bills
 *  third-party Marketplace usage (foundation models like Claude, partner AMIs,
 *  etc.) with an EMPTY `product_servicecode` and a $0 `pricing_public_on_demand_cost`
 *  — the real charge lands only in `line_item_unblended_cost`. A plain
 *  service-code grouping therefore buckets this spend under a blank service,
 *  and the `list` metric reports it as $0. This rule matches such rows by their
 *  billing `operation` and re-attributes them to a real `service` code (and, for
 *  the `list` metric, substitutes unblended cost for the missing list price).
 *
 *  The canonical case is Bedrock model inference (`InvokeModelInference`,
 *  `InvokeModelStreamingInference`) → `AmazonBedrock`. */
export interface MarketplaceAttributionRule {
  /** Service code matched rows are re-attributed to, e.g. `AmazonBedrock`. */
  readonly service: string;
  /** `line_item_operation` values identifying this rule's Marketplace rows.
   *  Only rows that ALSO have an empty `product_servicecode` are rewritten, so
   *  first-party usage on the same operation is never touched. */
  readonly operations: readonly string[];
}

/** Marketplace re-attribution settings. This deliberately rewrites the
 *  as-billed product code for practical readability, so it is a toggle —
 *  enabled by default, disable to see the raw CUR attribution. */
export interface MarketplaceAttributionConfig {
  readonly enabled: boolean;
  readonly rules: readonly MarketplaceAttributionRule[];
}

/** Number of most-recent days to exclude from all date ranges. AWS CUR
 *  data is not consolidated immediately, so the latest day(s) are
 *  typically incomplete. `0` = include today, `1` = end at yesterday,
 *  `2` (default) = end at the day before yesterday. */
export const DEFAULT_LAG_DAYS = 2;

export interface CostScopeConfig {
  readonly costMetric: CostMetric;
  /** How negotiated discounts are handled. Optional on disk; absent defaults to
   *  {@link DEFAULT_DISCOUNT_TREATMENT} ('itemized'). Replaced the former
   *  `costPerspective` field and the EDP/Bundled exclusion rules — legacy configs
   *  carrying either are migrated at load time (see cost-scope-validator.ts and
   *  mergeBuiltInExclusionRules). */
  readonly discountTreatment?: DiscountTreatment;
  /** How many recent days to trim from query date ranges. Defaults to
   *  `DEFAULT_LAG_DAYS` (2) when omitted. */
  readonly lagDays?: number | undefined;
  readonly rules: readonly ExclusionRule[];
  /** Re-attribution of AWS Marketplace line items. Optional on disk; absent
   *  configs default to {@link DEFAULT_MARKETPLACE_ATTRIBUTION} (enabled) at
   *  load time so existing installs pick up the fix. */
  readonly marketplaceAttribution?: MarketplaceAttributionConfig | undefined;
}

export interface CostScopePreviewRow {
  readonly ruleId: string;
  readonly excludedCost: number;
  readonly excludedRows: number;
}

/** One day of the preview histogram. `keptCost` is what survives the enabled
 *  exclusion rules under the chosen metric. `excludedCost` is what the same
 *  rules removed. They sum to the pre-exclusion total for that day under the
 *  chosen metric — useful for showing the "bite" as a stacked bar. */
export interface CostScopeDailyRow {
  readonly date: string;
  readonly keptCost: number;
  readonly excludedCost: number;
}

/** A single billing line item from the preview window, surfaced in the raw
 *  inspection table. `excluded` indicates whether the current exclusion
 *  rules would drop this row. `cost` reflects the chosen cost metric.
 *  `tags` carries the row's value for every configured tag dimension so the
 *  UI can render an arbitrary number of tag columns without adding new
 *  fields. */
export interface CostScopeSampleRow {
  readonly date: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly region: string;
  readonly service: string;
  readonly serviceFamily: string;
  readonly lineItemType: string;
  readonly operation: string;
  readonly usageType: string;
  readonly description: string;
  readonly resourceId: string;
  readonly usageAmount: number;
  readonly cost: number;
  readonly listCost: number;
  readonly excluded: boolean;
  readonly tags: Readonly<Record<string, string>>;
}

/** Which optional CUR columns exist in the user's export. Drives UI
 *  warnings (e.g. "Amortized is degraded — your CUR lacks the
 *  effective-cost columns"). The probe runs once per tier, cached for
 *  the session. */
export interface CostScopeCapabilities {
  /** `reservation_effective_cost` AND
   *  `savings_plan_savings_plan_effective_cost` are both present.
   *  Required for an accurate Amortized metric; when missing we
   *  degrade to Unblended. Both columns ship only when the CUR has
   *  "Include Resource IDs" enabled. */
  readonly hasEffectiveCostColumns: boolean;
  /** `line_item_net_unblended_cost` is present. Ships only when the
   *  CUR has "Include Net Columns" enabled. Without it, the Net
   *  perspective toggle falls back to Gross. */
  readonly hasNetColumns: boolean;
  /** `pricing_public_on_demand_cost` is present. Almost always true
   *  for CUR v2 exports but technically optional. Required for the
   *  `list` metric — without it, list-price queries return zeros. */
  readonly hasListPriceColumn: boolean;
}

export interface CostScopePreviewResult {
  readonly windowDays: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly perRule: readonly CostScopePreviewRow[];
  readonly combined: { readonly excludedCost: number; readonly excludedRows: number };
  /** Total cost over the window under the chosen metric, with no exclusions
   *  applied. Lets the UI show a "base" figure for comparison. */
  readonly unscopedTotalCost: number;
  /** Total under the chosen metric AND the enabled exclusion rules. */
  readonly scopedTotalCost: number;
  /** Daily breakdown for the window — one entry per day. Empty when no
   *  months in range are on disk yet. */
  readonly dailyTotals: readonly CostScopeDailyRow[];
  /** Top-|cost| line items in the window, sorted by absolute cost desc so
   *  the largest credits/refunds and the largest charges sit at the top.
   *  Capped so the IPC payload stays bounded. */
  readonly sampleRows: readonly CostScopeSampleRow[];
  /** Total underlying line-item count in the window (before the sample cap).
   *  Lets the UI say "showing 500 of 128,902 rows" honestly. */
  readonly sampleTotalRowCount: number;
  /** Names of configured tag dimensions in the order the UI should render
   *  them as columns. Extracted from dimensions config at query time. */
  readonly tagColumns: readonly { readonly id: string; readonly label: string }[];
}
