import { createHash } from 'node:crypto';
import type { DimensionsConfig, BuiltInDimension, TagDimension } from '../types/config.js';
import type { CostMetric, CostPerspective } from '../types/cost-scope.js';
import { tagColumnName } from '../types/branded.js';

/**
 * Rollup schema versioning.
 *
 * Bump when the on-disk parquet shape changes in a way that older readers can't
 * handle (new measure column, renamed dim column, etc.). The version is part of
 * the schema hash so any rollup written under an older version is treated as
 * stale and rebuilt.
 */
const ROLLUP_VERSION = 1;

/** Built-in dimensions that resolve to a column we never include in the rollup,
 *  because they push cardinality to ~raw size or aren't a real CUR column on
 *  their own (region_country/continent are derived from `region` at query time). */
const NON_ROLLUP_BUILTIN_FIELDS: ReadonlySet<string> = new Set([
  'resource_id',
  // description isn't currently a built-in dim but the explorer references it;
  // keep it out so rollup-eligibility short-circuits cleanly when it appears.
  'description',
]);

export interface RollupSchema {
  /** Stable hash. Changes when the shape of the rollup changes — driven by
   *  enabled built-in dims, enabled tags, cost metric, cost perspective, or a
   *  ROLLUP_VERSION bump. */
  readonly hash: string;
  /** Built-in dimension fields (column names) carried as group-by keys.
   *  Always includes `usage_date` first; deduplicated; sorted for stability. */
  readonly builtInFields: readonly string[];
  /** Tag column names (e.g. `tag_user_sb_team`) carried as group-by keys.
   *  Sorted for stability. */
  readonly tagColumns: readonly string[];
  /** Raw CUR tag keys (e.g. `user_sb_team`) corresponding to tagColumns, same
   *  order. Used by the build SQL to extract from the resource_tags MAP. */
  readonly tagRawKeys: readonly string[];
  /** Currently a single SUM measure named `cost`, computed from the user's
   *  metric+perspective. Stored as the column producer SQL fragment that
   *  becomes `SUM(<expr>) AS cost` in the build query. */
  readonly costMetric: CostMetric;
  readonly costPerspective: CostPerspective;
}

function isBuiltInEligibleForRollup(d: BuiltInDimension): boolean {
  if (d.enabled === false) return false;
  if (NON_ROLLUP_BUILTIN_FIELDS.has(d.field)) return false;
  return true;
}

function isTagEligibleForRollup(d: TagDimension): boolean {
  return d.enabled !== false;
}

function rawTagKey(tagName: string): string {
  return tagName.startsWith('user_') ? tagName : `user_${tagName}`;
}

/**
 * Derive the rollup schema from the user's dimensions config and cost shape.
 *
 * Built-ins keep their canonical output names (account_id, region, service,
 * service_family, line_item_type, usage_type, operation, ...) — same names
 * that buildSource() emits, so the rollup parquet can stand in for the inner
 * SELECT without renaming columns.
 *
 * `account_name` is always included alongside `account_id`. It's a per-account
 * constant in CUR (1:1 with account_id), so it doesn't grow cardinality and
 * carrying it lets account-grouped queries skip a JSON lookup.
 */
export function deriveRollupSchema(
  dimensions: DimensionsConfig,
  costMetric: CostMetric,
  costPerspective: CostPerspective,
): RollupSchema {
  const builtInFields = new Set<string>(['usage_date']);
  for (const d of dimensions.builtIn) {
    if (!isBuiltInEligibleForRollup(d)) continue;
    builtInFields.add(d.field);
  }
  // account_name rides along with account_id — only when the latter is in.
  if (builtInFields.has('account_id')) builtInFields.add('account_name');

  const enabledTags = dimensions.tags
    .filter(isTagEligibleForRollup)
    .map(t => ({ col: tagColumnName(t.tagName), raw: rawTagKey(t.tagName) }));

  const tagColumns = enabledTags.map(t => t.col).sort((a, b) => a.localeCompare(b));
  const tagRawKeys = tagColumns.map(col => {
    const found = enabledTags.find(t => t.col === col);
    if (found === undefined) throw new Error(`unreachable: tag column ${col} not found`);
    return found.raw;
  });

  const sortedBuiltIn = [...builtInFields].sort((a, b) => a.localeCompare(b));

  const hash = createHash('sha256').update(JSON.stringify({
    v: ROLLUP_VERSION,
    builtIn: sortedBuiltIn,
    tags: tagColumns,
    metric: costMetric,
    perspective: costPerspective,
  })).digest('hex').slice(0, 16);

  return {
    hash,
    builtInFields: sortedBuiltIn,
    tagColumns,
    tagRawKeys,
    costMetric,
    costPerspective,
  };
}

/** All output columns the rollup parquet will have, in stable order.
 *  Useful for SELECT * targets and for tests asserting parquet shape. */
export function rollupOutputColumns(schema: RollupSchema): readonly string[] {
  return [
    ...schema.builtInFields,
    ...schema.tagColumns,
    'cost',
    'list_cost',
    'usage_amount',
    'row_count',
  ];
}
