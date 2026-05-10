import type { DimensionsConfig } from '../types/config.js';
import type { DimensionId } from '../types/branded.js';
import { tagColumnName } from '../types/branded.js';
import type { CostScopeConfig } from '../types/cost-scope.js';
import type { RollupSchema } from './schema.js';

/** Fields that, if referenced anywhere in the query, force a fall-back to raw.
 *  These are columns the rollup deliberately doesn't carry. */
const RAW_ONLY_FIELDS: ReadonlySet<string> = new Set([
  'resource_id',
  'description',
]);

/** Resolve a dimension id to the underlying CUR field name. Returns null when
 *  the id is unknown (caller should treat as "force raw" — we can't reason
 *  about what we can't see). */
function resolveFieldName(id: DimensionId, dimensions: DimensionsConfig): string | null {
  const builtIn = dimensions.builtIn.find(d => d.name === id);
  if (builtIn !== undefined) return builtIn.field;
  const tag = dimensions.tags.find(d => tagColumnName(d.tagName) === id);
  if (tag !== undefined) return tagColumnName(tag.tagName);
  return null;
}

export interface RollupEligibilityInput {
  readonly schema: RollupSchema;
  readonly dimensions: DimensionsConfig;
  /** Fields the query selects/filters/groups by. Caller is responsible for
   *  enumerating these — usually one or two ids. */
  readonly referencedDimensionIds: readonly DimensionId[];
  /** Filters and groupBy on these raw fields ALREADY exist in the rollup
   *  (e.g. usage_date is always present). Listed here as a fast-path. */
  readonly extraReferencedFields?: readonly string[];
  /** When true the caller plans to use raw-tag detection (missing-tags query)
   *  or other features that bypass aggregation — short-circuit to raw. */
  readonly needsRawRows?: boolean;
  /** Cost scope conditions reference dimensions too — if any condition's
   *  dimension isn't in the rollup we must read raw to apply the exclusion
   *  correctly. Pass undefined when no scope is configured. */
  readonly costScope?: CostScopeConfig | undefined;
}

/**
 * Decide whether a query can read from the rollup parquet (true) or must use
 * raw (false). Conservative — any uncertainty falls back to raw, which is
 * correct but slower.
 */
export function isRollupEligible(input: RollupEligibilityInput): boolean {
  const { schema, dimensions, referencedDimensionIds, extraReferencedFields, needsRawRows, costScope } = input;

  if (needsRawRows === true) return false;

  const carried = new Set<string>([...schema.builtInFields, ...schema.tagColumns]);

  for (const id of referencedDimensionIds) {
    const field = resolveFieldName(id, dimensions);
    if (field === null) return false;
    if (RAW_ONLY_FIELDS.has(field)) return false;
    if (!carried.has(field)) return false;
  }

  for (const field of extraReferencedFields ?? []) {
    if (RAW_ONLY_FIELDS.has(field)) return false;
    if (!carried.has(field)) return false;
  }

  if (costScope !== undefined) {
    for (const rule of costScope.rules) {
      if (!rule.enabled) continue;
      for (const cond of rule.conditions) {
        const field = resolveFieldName(cond.dimensionId, dimensions);
        if (field === null) return false;
        if (RAW_ONLY_FIELDS.has(field)) return false;
        if (!carried.has(field)) return false;
      }
    }
  }

  return true;
}
