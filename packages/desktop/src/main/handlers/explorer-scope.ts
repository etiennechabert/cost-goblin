import type { CostMetric } from '@costgoblin/core';

/** The cost-scope fields a query can inherit when it doesn't override them. */
interface InheritableScope {
  readonly costMetric?: CostMetric | undefined;
}

/** Resolve the effective cost metric for an Explorer-endpoint query.
 *
 *  An explicit `requested` metric always wins (the Explorer view drives its own
 *  independent toggles). When it's absent AND the caller asked to apply the cost
 *  scope, inherit the scope's configured metric — this is what dashboard widgets
 *  rely on: they send `applyCostScope: true` and expect the global metric, not a
 *  silent default. Falls back to `billed` (the invoice-faithful metric the
 *  Explorer's raw-inspection intent matches; all four FOCUS cost columns are
 *  always present, so no capability gating is needed). */
export function resolveScopeMetric(
  requested: CostMetric | undefined,
  applyCostScope: boolean,
  scope: InheritableScope | undefined,
): CostMetric {
  return requested ?? (applyCostScope ? scope?.costMetric : undefined) ?? 'billed';
}
