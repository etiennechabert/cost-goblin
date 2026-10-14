/** Explorer columns that are source columns under their own name. */
const SORTABLE_SCALAR_COLUMNS: ReadonlySet<string> = new Set([
  'usage_date',
  'usage_hour',
  'account_id',
  'account_name',
  'region',
  'service',
  'service_code',
  'service_category',
  'charge_category',
  'pricing_category',
  'commitment_status',
  'operation',
  'sku_meter',
  'description',
  'resource_id',
  'usage_amount',
  'cost',
  'list_cost',
]);

/** The SQL column behind an Explorer column id: a scalar column is its own
 *  column, a tag id maps through `tagSqlColumns` (see tagSqlColumnsById).
 *  Null for anything else: this is the allow-list that keeps
 *  renderer-supplied ids out of the SQL. */
export function explorerSqlColumn(id: string, tagSqlColumns: ReadonlyMap<string, string>): string | null {
  if (SORTABLE_SCALAR_COLUMNS.has(id)) return id;
  return tagSqlColumns.get(id) ?? null;
}
