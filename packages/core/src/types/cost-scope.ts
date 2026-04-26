import type { DimensionId } from './branded.js';

/** Which cost perspective backs the `cost` alias in every query.
 *  - `unblended`  — what you were actually billed; upfront RI/SP fees land
 *                   as a lump in their month.
 *  - `blended`    — consolidated-billing blended rate (weighted average of
 *                   usage rates across the accounts in the org). Reporting
 *                   construct; makes linked-account costs comparable.
 *  - `amortized`  — spreads RI/SP upfront payments over their term and uses
 *                   effective cost for covered usage. Best for run-rate and
 *                   forecasting.
 *  The SQL expression that each value resolves to lives in
 *  packages/core/src/query/cost-metric.ts. Net-of-credits is a separate
 *  axis we haven't shipped yet; see `costPerspective` below when it lands. */
export type CostMetric = 'unblended' | 'blended' | 'amortized';

export const COST_METRICS: readonly CostMetric[] = ['unblended', 'blended', 'amortized'] as const;

/** Whether the cost column should be the as-billed ("gross") value or the
 *  post-credit/refund ("net") value. Orthogonal to the metric axis —
 *  every metric has a net variant in CUR when "Include Net Columns" is
 *  enabled on the report. When net columns are missing, the expression
 *  falls back to the gross column for that metric. */
export type CostPerspective = 'gross' | 'net';

export const COST_PERSPECTIVES: readonly CostPerspective[] = ['gross', 'net'] as const;

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

/** Number of most-recent days to exclude from all date ranges. AWS CUR
 *  data is not consolidated immediately, so the latest day(s) are
 *  typically incomplete. `0` = include today, `1` = end at yesterday,
 *  `2` (default) = end at the day before yesterday. */
export const DEFAULT_LAG_DAYS = 2;

export interface CostScopeConfig {
  readonly costMetric: CostMetric;
  /** Optional. Defaults to 'gross' when omitted (back-compat with
   *  earlier on-disk configs that predate the perspective axis). */
  readonly costPerspective?: CostPerspective;
  /** How many recent days to trim from query date ranges. Defaults to
   *  `DEFAULT_LAG_DAYS` (2) when omitted. */
  readonly lagDays?: number | undefined;
  readonly rules: readonly ExclusionRule[];
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
  /** `line_item_blended_cost` is present. Usually true, but some CUR
   *  configurations omit it — when missing we degrade Blended to
   *  Unblended. */
  readonly hasBlendedColumn: boolean;
  /** `line_item_net_unblended_cost` is present. Ships only when the
   *  CUR has "Include Net Columns" enabled. Without it, the Net
   *  perspective toggle falls back to Gross. */
  readonly hasNetColumns: boolean;
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
