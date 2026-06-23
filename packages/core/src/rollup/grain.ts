import type { DimensionsConfig } from '../types/config.js';
import { tagDimColumn } from '../types/branded.js';

function isEnabled(d: { readonly enabled?: boolean | undefined }): boolean {
  return d.enabled !== false;
}

/** The non-aggregate columns of a rollup partition: `usage_date` plus every
 *  ENABLED dimension's stored column — a built-in's `field`, its `displayField`
 *  when set (e.g. account_name), and enabled tag columns. Deduped and sorted
 *  (usage_date first) for a stable GROUP BY / SELECT and a stable on-disk
 *  schema. Disabled / high-cardinality built-ins (resource_id, operation,
 *  region or usage_type when off) are absent — they get aggregated away. */
export function rollupGrainColumns(dims: DimensionsConfig): string[] {
  const cols = new Set<string>();
  for (const d of dims.builtIn) {
    if (!isEnabled(d)) continue;
    cols.add(d.field);
    if (d.displayField !== undefined && d.displayField.length > 0) cols.add(d.displayField);
  }
  for (const t of dims.tags) if (isEnabled(t)) cols.add(tagDimColumn(t));
  const rest = [...cols].filter(c => c !== 'usage_date').sort((a, b) => a.localeCompare(b));
  return ['usage_date', ...rest];
}
