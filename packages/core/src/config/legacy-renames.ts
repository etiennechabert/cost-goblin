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

/** Rename a CUR-era dimension/column id to its FOCUS successor; pass-through
 *  for everything else. */
export function migrateLegacyDimensionId(id: string): string {
  return LEGACY_DIMENSION_ID_RENAMES[id] ?? id;
}
