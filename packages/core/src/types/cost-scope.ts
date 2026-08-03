import type { DimensionId } from './branded.js';

/** Which FOCUS 1.2 cost column backs the `cost` alias in every query.
 *  - `billed`     — `BilledCost`: the basis for invoicing. Excludes
 *                   amortization of upfront/recurring commitment fees;
 *                   commitment-covered usage rows carry 0 and the invoiced
 *                   amount sits on `ChargeCategory='Purchase'` rows. Use for
 *                   invoice reconciliation.
 *  - `effective`  — `EffectiveCost`: amortized cost. Spreads commitment
 *                   purchases over the usage they cover and includes the
 *                   unused portion of commitments
 *                   (`CommitmentDiscountStatus='Unused'` rows). Matches Cost
 *                   Explorer's amortized view. The default for attribution.
 *  - `list`       — `ListCost`: hypothetical list-price cost, ignoring all
 *                   negotiated and commitment discounts. Not money actually
 *                   spent. When selected, queries are restricted to
 *                   `ChargeCategory='Usage'` rows because purchase/tax/credit
 *                   rows have no list price.
 *  - `contracted` — `ContractedCost`: price after negotiated (e.g. EDP)
 *                   discounts but before commitment discounts.
 *                   `list − contracted` is what the negotiated discount is
 *                   worth.
 *
 *  Legacy CUR-era metric names on disk (`unblended`, `amortized`, `blended`)
 *  are silently migrated at load time (see cost-scope-validator.ts):
 *  `unblended` → `billed`, `amortized`/`blended` → `effective`. The CUR-era
 *  `net` perspective is gone — FOCUS has no net cost columns.
 *
 *  The SQL expression each value resolves to lives in
 *  packages/core/src/query/cost-metric.ts. */
export type CostMetric = 'billed' | 'effective' | 'list' | 'contracted';

export const COST_METRICS: readonly CostMetric[] = ['billed', 'effective', 'list', 'contracted'] as const;

/** The metric every query layer falls back to when no Cost Scope is
 *  configured (or fails to load). One constant rather than scattered
 *  'effective' literals: the rollup shape signature and the rollup build
 *  must agree on the fallback, or a signature mismatch would silently serve
 *  partitions built under a different metric. (The Explorer's raw-inspection
 *  default of 'billed' is a deliberate, separate choice — see
 *  resolveScopeMetric in the desktop explorer handlers.) */
export const DEFAULT_COST_METRIC: CostMetric = 'effective';

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
 *  etc.) with an EMPTY service code — in FOCUS, an empty `x_ServiceCode` (and
 *  a `PublisherName` naming the seller rather than AWS). A plain service
 *  grouping therefore buckets this spend under a blank service, and the
 *  `list` metric reports it as $0 because Marketplace rows carry no public
 *  list price. This rule matches such rows by their billing `x_Operation` and
 *  re-attributes them to a real `service` value (and, for the `list` metric,
 *  substitutes `BilledCost` for the missing list price).
 *
 *  The canonical case is Bedrock model inference (`InvokeModelInference`,
 *  `InvokeModelStreamingInference`) → `Amazon Bedrock`. */
export interface MarketplaceAttributionRule {
  /** `ServiceName` value matched rows are re-attributed to, e.g.
   *  `Amazon Bedrock`. */
  readonly service: string;
  /** `x_Operation` values identifying this rule's Marketplace rows. Only
   *  rows that ALSO have an empty `x_ServiceCode` are rewritten, so
   *  first-party usage on the same operation is never touched. */
  readonly operations: readonly string[];
}

/** Marketplace re-attribution settings. This deliberately rewrites the
 *  as-billed service attribution for practical readability, so it is a
 *  toggle — enabled by default, disable to see the raw FOCUS attribution. */
export interface MarketplaceAttributionConfig {
  readonly enabled: boolean;
  readonly rules: readonly MarketplaceAttributionRule[];
}

/** Number of most-recent days to exclude from all date ranges. AWS billing
 *  data is not consolidated immediately, so the latest day(s) are
 *  typically incomplete. `0` = include today, `1` = end at yesterday,
 *  `2` (default) = end at the day before yesterday. */
export const DEFAULT_LAG_DAYS = 2;

export interface CostScopeConfig {
  readonly costMetric: CostMetric;
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
  readonly serviceCategory: string;
  readonly chargeCategory: string;
  readonly operation: string;
  readonly skuMeter: string;
  readonly description: string;
  readonly resourceId: string;
  readonly usageAmount: number;
  readonly cost: number;
  readonly listCost: number;
  readonly excluded: boolean;
  readonly tags: Readonly<Record<string, string>>;
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
