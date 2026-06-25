import type { DimensionsConfig } from '../types/config.js';
import { tagDimColumn } from '../types/branded.js';

function isEnabled(d: { readonly enabled?: boolean | undefined }): boolean {
  return d.enabled !== false;
}

/** Built-in fields kept OUT of the rollup grain regardless of enabled-state.
 *  These are ultra-high-cardinality columns — `usage_type` alone has ~950
 *  distinct values and ~3×'s the partition — that no dashboard chart groups or
 *  filters by. Including an enabled `usage_type` exploded a real rollup to
 *  ~22 MB/month vs the ~7 MB design target. Queries that DO group/filter by
 *  these fall back to raw via `resolveSource` (their column isn't in-grain).
 *
 *  Interim policy: a fixed list. The design's §8 estimator will eventually flag
 *  raw-only dims by measured cardinality instead. Changing this set changes the
 *  shape signature (it feeds `computeShapeSignature`) and re-rolls. */
export const ROLLUP_RAW_ONLY_FIELDS: ReadonlySet<string> = new Set(['usage_type', 'operation', 'resource_id']);

/** `usage_date` + EVERY enabled dimension's stored column — a built-in's
 *  `field`, its `displayField` when set (e.g. account_name), and enabled tag
 *  columns — with NO raw-only pruning. Deduped and sorted (usage_date first).
 *
 *  This is the CANDIDATE grain the §8 estimator probes: to advise the user which
 *  dims to keep raw-only it must measure *every* enabled dim, including the
 *  high-cardinality ones the actual rollup excludes. The stored grain that backs
 *  partitions is {@link rollupGrainColumns} — this minus {@link ROLLUP_RAW_ONLY_FIELDS}. */
export function rollupCandidateColumns(dims: DimensionsConfig): string[] {
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

/** The non-aggregate columns actually STORED in a rollup partition: the
 *  candidate grain ({@link rollupCandidateColumns}) minus the always-raw-only
 *  fields ({@link ROLLUP_RAW_ONLY_FIELDS}), which get aggregated away. Backs the
 *  partition build, the routing gate, and the shape signature. */
export function rollupGrainColumns(dims: DimensionsConfig): string[] {
  return rollupCandidateColumns(dims).filter(c => !ROLLUP_RAW_ONLY_FIELDS.has(c));
}
