import type { DimensionId } from './branded.js';

/** Which Parquet cost column backs the `cost` alias in every query.
 *  Extend the switch in packages/core/src/query/cost-metric.ts when adding
 *  new metrics (amortized, net_*). */
export type CostMetric = 'unblended' | 'blended' | 'list';

export const COST_METRICS: readonly CostMetric[] = ['unblended', 'blended', 'list'] as const;

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

export interface CostScopeConfig {
  readonly costMetric: CostMetric;
  readonly rules: readonly ExclusionRule[];
}

export interface CostScopePreviewRow {
  readonly ruleId: string;
  readonly excludedCost: number;
  readonly excludedRows: number;
}

export interface CostScopePreviewResult {
  readonly windowDays: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly perRule: readonly CostScopePreviewRow[];
  readonly combined: { readonly excludedCost: number; readonly excludedRows: number };
}
