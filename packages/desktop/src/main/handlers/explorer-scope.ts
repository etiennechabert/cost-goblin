import type { CostMetric, CostPerspective, DiscountTreatment } from '@costgoblin/core';
import { discountPerspective } from '@costgoblin/core';

/** Capability-gate a requested cost metric against the columns actually present
 *  in the user's Parquet. An unsupported (or absent) metric degrades to
 *  `unblended`, which is always available. Mirrors the gating the main query
 *  path relies on via `costExprFor`'s column fallbacks. */
export function pickMetric(metric: CostMetric | undefined, cols: ReadonlySet<string>): CostMetric {
  if (metric === 'amortized' && cols.has('reservation_effective_cost') && cols.has('savings_plan_savings_plan_effective_cost')) return 'amortized';
  if (metric === 'list' && cols.has('pricing_public_on_demand_cost')) return 'list';
  return 'unblended';
}

/** Capability-gate a requested perspective. `net` needs the net-cost column;
 *  otherwise degrade to `gross`. */
export function pickPerspective(p: CostPerspective | undefined, cols: ReadonlySet<string>): CostPerspective {
  if (p === 'net' && cols.has('line_item_net_unblended_cost')) return 'net';
  return 'gross';
}

/** The cost-scope fields a query can inherit when it doesn't override them. */
interface InheritableScope {
  readonly costMetric?: CostMetric | undefined;
  readonly discountTreatment?: DiscountTreatment | undefined;
}

/** Resolve the effective cost metric for an Explorer-endpoint query.
 *
 *  An explicit `requested` metric always wins (the Explorer view drives its own
 *  independent toggles). When it's absent AND the caller asked to apply the cost
 *  scope, inherit the scope's configured metric — this is what dashboard widgets
 *  rely on: they send `applyCostScope: true` and expect the global metric, not a
 *  silent `unblended` default. The result is still capability-gated. */
export function resolveScopeMetric(
  requested: CostMetric | undefined,
  applyCostScope: boolean,
  scope: InheritableScope | undefined,
  cols: ReadonlySet<string>,
): CostMetric {
  const inherited = requested ?? (applyCostScope ? scope?.costMetric : undefined);
  return pickMetric(inherited, cols);
}

/** Perspective counterpart of {@link resolveScopeMetric}. The Explorer's own
 *  gross/net override (`requested`) still wins; when absent and the scope
 *  applies, the perspective is DERIVED from the scope's discount treatment
 *  (`spread` → net, otherwise gross). */
export function resolveScopePerspective(
  requested: CostPerspective | undefined,
  applyCostScope: boolean,
  scope: InheritableScope | undefined,
  cols: ReadonlySet<string>,
): CostPerspective {
  const inherited = requested ?? (applyCostScope && scope !== undefined ? discountPerspective(scope) : undefined);
  return pickPerspective(inherited, cols);
}
