import { tagDimColumn } from '../types/branded.js';
import type { DimensionsConfig } from '../types/config.js';

/** CUR-era → FOCUS 1.2 canonical dimension/column renames (#515).
 *
 *  Persisted state written before the FOCUS migration references dimensions
 *  whose backing canonical columns no longer exist: saved views (widget
 *  groupBy/drillTo, table enabledColumns), baseline scope filters, explorer
 *  preferences (hidden/ordered column ids). Loaders route those ids through
 *  this map so old state keeps working — same pattern as the legacy cost
 *  metric migration in cost-scope-validator.ts. */
export const LEGACY_DIMENSION_ID_RENAMES: Readonly<Record<string, string>> = {
  service_family: 'service_category',
  line_item_type: 'charge_category',
  usage_type: 'sku_meter',
};

/** CUR-era tag dimension ids carried the `user_` prefix of their raw
 *  `resource_tags` key (`tag_user_team`). The FOCUS migration strips that
 *  prefix from `tagName` at config load (see validateTagDimension), which
 *  shifts the derived column id to `tag_team` — so persisted references to
 *  the old id must follow. The prefix strip in the validator only covers
 *  tagNames that literally start with `user_`, so a FOCUS-era tag key like
 *  `user:CostCenter` or `user team` (sanitized: every non-alphanumeric → `_`)
 *  yields a LIVE dimension id of the same `tag_user_*` shape — callers that
 *  know the current dimensions pass `liveDimensionIds` so those are never
 *  misrenamed. Without the set (no dimensions in scope), the common
 *  CUR-era `user_<key>` reading wins. */
const LEGACY_TAG_PREFIX = 'tag_user_';

/** The set of dimension ids that exist in the given dimensions config:
 *  built-in names plus derived tag-dimension column ids. An id in this set
 *  is live — `migrateLegacyDimensionId` must pass it through untouched. */
export function dimensionIdSet(dimensions: DimensionsConfig): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const d of dimensions.builtIn) ids.add(String(d.name));
  for (const t of dimensions.tags) ids.add(tagDimColumn(t));
  return ids;
}

/** Rename a CUR-era dimension/column id to its FOCUS successor; pass-through
 *  for everything else. Ids present in `liveDimensionIds` are current-config
 *  dimensions, not CUR leftovers — they are never renamed. The rename map is
 *  read with an own-property guard: ids come from git-shareable config files,
 *  so a key like `constructor` must not surface prototype members. */
export function migrateLegacyDimensionId(id: string, liveDimensionIds?: ReadonlySet<string>): string {
  if (liveDimensionIds?.has(id) === true) return id;
  const direct = Object.hasOwn(LEGACY_DIMENSION_ID_RENAMES, id)
    ? LEGACY_DIMENSION_ID_RENAMES[id]
    : undefined;
  if (direct !== undefined) return direct;
  if (id.startsWith(LEGACY_TAG_PREFIX) && id.length > LEGACY_TAG_PREFIX.length) {
    return `tag_${id.slice(LEGACY_TAG_PREFIX.length)}`;
  }
  return id;
}
