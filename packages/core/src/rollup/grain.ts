import type { BuiltInDimension, DimensionsConfig } from '../types/config.js';
import { tagDimColumn } from '../types/branded.js';
import { assertSafeColumnIdentifier } from '../query/identifier-validator.js';

function isEnabled(d: { readonly enabled?: boolean | undefined }): boolean {
  return d.enabled !== false;
}

/** The grain columns a built-in stores: its `field`, plus `displayField` when
 *  set. Both are interpolated bare into the rollup COPY and the grain probe,
 *  so each is identifier-checked here — these producers are exported and the
 *  estimate handler feeds them renderer input. */
function builtInGrainColumns(d: BuiltInDimension): string[] {
  assertSafeColumnIdentifier(d.field, `built-in dimension "${String(d.name)}" field`);
  const columns = [d.field];
  if (d.displayField !== undefined && d.displayField.length > 0) {
    assertSafeColumnIdentifier(d.displayField, `built-in dimension "${String(d.name)}" displayField`);
    columns.push(d.displayField);
  }
  return columns;
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
    // `provider` is injected at read time (constant per provider branch /
    // per rollup store) — it is never stored in rollup Parquet, so it must
    // not enter the grain even when the provider dimension is enabled.
    if (d.field === 'provider') continue;
    for (const c of builtInGrainColumns(d)) cols.add(c);
  }
  for (const t of dims.tags) if (isEnabled(t)) cols.add(tagDimColumn(t));
  const rest = [...cols].filter(c => c !== 'usage_date').sort((a, b) => a.localeCompare(b));
  return ['usage_date', ...rest];
}

/** The enabled dimensions as grain groups: each dimension's primary column (a
 *  built-in's `field`, or a tag's column) paired with EVERY grain column it
 *  contributes (a built-in also stores its `displayField`). Used by the grain
 *  probe to attribute marginal rollup size PER DIMENSION — removing a built-in
 *  drops both its id and its display column together, so a 1:1 display column
 *  (e.g. account_name ↔ account_id) is never measured as a redundant
 *  pseudo-dimension. Built-ins first, then tags (same enabled-set semantics as
 *  rollupGrainColumns).
 *
 *  DEDUPED BY PRIMARY COLUMN: several dimensions can map to the SAME physical
 *  grain column — Region, Country and Continent are all query-time views of the
 *  one `region` column. They are not independent grain groups (the rollup stores
 *  the column once), so they collapse to a single entry; otherwise the probe
 *  would emit identical, mis-attributed duplicate rows. */
export function rollupGrainDimensions(dims: DimensionsConfig): { column: string; columns: string[] }[] {
  const out: { column: string; columns: string[] }[] = [];
  const seen = new Set<string>();
  const add = (column: string, columns: string[]): void => {
    if (seen.has(column)) return;
    seen.add(column);
    out.push({ column, columns });
  };
  for (const d of dims.builtIn) {
    if (!isEnabled(d)) continue;
    // Injected at read time, never stored — see rollupGrainColumns.
    if (d.field === 'provider') continue;
    add(d.field, builtInGrainColumns(d));
  }
  for (const t of dims.tags) {
    if (!isEnabled(t)) continue;
    const col = tagDimColumn(t);
    add(col, [col]);
  }
  return out;
}
