import { asDimensionId } from '../types/branded.js';
import type { CostPerspective, DiscountTreatment, ExclusionRule } from '../types/cost-scope.js';
import { DEFAULT_DISCOUNT_TREATMENT } from '../types/cost-scope.js';

/** Line-item types AWS emits as standalone negative negotiated-discount rows.
 *  The `excluded` treatment drops exactly these; the `spread`/net columns zero
 *  them out and fold their value into the usage lines instead. */
export const NEGOTIATED_DISCOUNT_LINE_ITEM_TYPES = ['EdpDiscount', 'BundledDiscount'] as const;

interface DiscountScope {
  readonly discountTreatment?: DiscountTreatment | undefined;
  readonly rules: readonly ExclusionRule[];
}

function treatmentOf(scope: { readonly discountTreatment?: DiscountTreatment | undefined } | undefined): DiscountTreatment {
  return scope?.discountTreatment ?? DEFAULT_DISCOUNT_TREATMENT;
}

/** The cost-column family a scope's discount treatment maps to. `spread` uses
 *  AWS net columns (discounts folded into each line); everything else is gross. */
export function discountPerspective(
  scope: { readonly discountTreatment?: DiscountTreatment | undefined } | undefined,
): CostPerspective {
  return treatmentOf(scope) === 'spread' ? 'net' : 'gross';
}

/** Synthetic, non-persisted exclusion rule applied only for the `excluded`
 *  treatment: drops the standalone negotiated-discount rows so queries show
 *  pre-negotiation cost. Its conditions mirror the retired
 *  `builtin:negotiated-discounts` rule, so it contributes an identical
 *  rollup-signature digest (no spurious rebuild for users already on that rule). */
export function negotiatedDiscountExclusionRule(): ExclusionRule {
  return {
    id: 'derived:negotiated-discounts',
    name: 'Negotiated discounts',
    enabled: true,
    builtIn: true,
    conditions: [
      { dimensionId: asDimensionId('line_item_type'), values: [...NEGOTIATED_DISCOUNT_LINE_ITEM_TYPES] },
    ],
  };
}

/** The exclusion rules a query should actually apply: the configured rules,
 *  plus the synthetic negotiated-discount exclusion when the treatment is
 *  `excluded`. Every query/rollup path that consumes `costScope.rules` should
 *  go through this so the discount treatment is honoured consistently. */
export function effectiveExclusionRules(scope: DiscountScope | undefined): readonly ExclusionRule[] {
  if (scope === undefined) return [];
  return treatmentOf(scope) === 'excluded'
    ? [...scope.rules, negotiatedDiscountExclusionRule()]
    : scope.rules;
}
