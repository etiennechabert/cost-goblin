import type { EntityRef } from '@costgoblin/core/browser';

export interface PriceVolumeInput {
  readonly name: string;
  readonly entity?: EntityRef | undefined;
  readonly prevCost: number;
  readonly currCost: number;
  readonly prevUsage: number;
  readonly currUsage: number;
  readonly prevListCost?: number | undefined;
  readonly currListCost?: number | undefined;
}

export interface PriceVolumeDecomp {
  readonly name: string;
  readonly entity: EntityRef | null;
  readonly prevCost: number;
  readonly currCost: number;
  readonly totalDelta: number;
  /** Change attributable to usage quantity, holding the prior rate fixed. */
  readonly volumeEffect: number;
  /** Change attributable to the effective $/unit, on current usage. */
  readonly rateEffect: number;
  /** False when usage is missing on either side, so the split is unavailable
   *  and the whole delta is reported as `volumeEffect` (a "mixed" remainder). */
  readonly decomposable: boolean;
  readonly prevRate: number | null;
  readonly currRate: number | null;
  /** Discount depth = 1 − cost/list_cost, when a list price is present. */
  readonly prevDiscount: number | null;
  readonly currDiscount: number | null;
}

function discountDepth(cost: number, listCost: number | undefined): number | null {
  if (listCost === undefined || listCost <= 0) return null;
  return 1 - cost / listCost;
}

/** Price–volume–mix decomposition of a per-group cost change:
 *    volumeEffect = (Δusage) × prevRate
 *    rateEffect   = (Δrate)  × currUsage
 *  which sum exactly to currCost − prevCost. The effective rate is post-discount
 *  (cost/usage), so a discount change surfaces inside `rateEffect`; `*Discount`
 *  expose the depth separately for context. */
export function decomposePriceVolume(input: PriceVolumeInput): PriceVolumeDecomp {
  const { prevCost, currCost, prevUsage, currUsage } = input;
  const totalDelta = currCost - prevCost;
  const prevRate = prevUsage > 0 ? prevCost / prevUsage : null;
  const currRate = currUsage > 0 ? currCost / currUsage : null;

  let volumeEffect = totalDelta;
  let rateEffect = 0;
  let decomposable = false;
  if (prevRate !== null && currRate !== null) {
    volumeEffect = (currUsage - prevUsage) * prevRate;
    rateEffect = (currRate - prevRate) * currUsage;
    decomposable = true;
  }

  return {
    name: input.name,
    entity: input.entity ?? null,
    prevCost,
    currCost,
    totalDelta,
    volumeEffect,
    rateEffect,
    decomposable,
    prevRate,
    currRate,
    prevDiscount: discountDepth(prevCost, input.prevListCost),
    currDiscount: discountDepth(currCost, input.currListCost),
  };
}
