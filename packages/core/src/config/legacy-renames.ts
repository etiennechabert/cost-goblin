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
 *  the old id must follow. The rename is total: no post-migration config can
 *  produce a `tag_user_*` id, because the validator strips the prefix from
 *  every tagName. (A tag key like `user team` — `user` + non-underscore
 *  separator — sanitizes to the same `tag_user_*` shape and would be
 *  misrenamed, but that requires a key the CUR era would have stored as
 *  `user_user team`; the common `user_<key>` case wins.) */
const LEGACY_TAG_PREFIX = 'tag_user_';

/** Rename a CUR-era dimension/column id to its FOCUS successor; pass-through
 *  for everything else. */
export function migrateLegacyDimensionId(id: string): string {
  const direct = LEGACY_DIMENSION_ID_RENAMES[id];
  if (direct !== undefined) return direct;
  if (id.startsWith(LEGACY_TAG_PREFIX) && id.length > LEGACY_TAG_PREFIX.length) {
    return `tag_${id.slice(LEGACY_TAG_PREFIX.length)}`;
  }
  return id;
}
