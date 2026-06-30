import type { DimensionId } from '../types/branded.js';
import type { BuiltInDimension, DimensionsConfig } from '../types/config.js';
import { isDimRawOnly } from '../rollup/estimator.js';

export interface DiscoveryGrainInput {
  readonly dimensions: DimensionsConfig;
  /** Distinct-value count per built-in dimension column (`field`). */
  readonly cardinalityByColumn: Readonly<Record<string, number>>;
  readonly lineItems: number;
  readonly bytesPerRow: number;
  /** Explicit override of which built-in dimension ids to enumerate. Empty →
   *  auto (all enabled built-ins minus high-cardinality). */
  readonly override: readonly DimensionId[];
}

function dedupeByField(dims: readonly BuiltInDimension[]): readonly BuiltInDimension[] {
  const seen = new Set<string>();
  const out: BuiltInDimension[] = [];
  for (const d of dims) {
    if (seen.has(d.field)) continue;
    seen.add(d.field);
    out.push(d);
  }
  return out;
}

/** Resolve which built-in dimensions baseline discovery enumerates. Tag
 *  dimensions are never included (the no-tags rule). With no override, returns
 *  the enabled built-ins minus any the existing cardinality heuristic flags
 *  raw-only (e.g. `resource_id`) — so the default grain stays stable and the
 *  partition doesn't explode. Dimensions sharing a physical column (Region /
 *  Country / Continent) are collapsed to one. */
export function resolveDiscoveryGrain(input: DiscoveryGrainInput): readonly BuiltInDimension[] {
  const enabled = input.dimensions.builtIn.filter((d) => d.enabled !== false);
  if (input.override.length > 0) {
    const ids = new Set<string>(input.override);
    return dedupeByField(enabled.filter((d) => ids.has(d.name)));
  }
  const stable = enabled.filter((d) => {
    const card = input.cardinalityByColumn[d.field] ?? 0;
    return !isDimRawOnly(card, input.lineItems, input.bytesPerRow);
  });
  return dedupeByField(stable);
}
