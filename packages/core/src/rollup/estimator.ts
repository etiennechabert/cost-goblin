/**
 * Grain cost/benefit estimator (rollup design §8).
 *
 * When the user toggles a dashboard dimension the rollup grain changes, which
 * re-rolls every partition in the background. This module turns a cheap
 * recent-month cardinality probe (run by the desktop handler) into the
 * cost/benefit numbers shown before the user commits: estimated size, how much
 * the rollup compresses the raw line items, an approximate rebuild time, and a
 * data-driven "raw-only" recommendation for ultra-high-cardinality dims such as
 * `resource_id`.
 *
 * The numbers are deliberately DIRECTIONAL, not exact — the probe samples a
 * single recent month (≈ −10% on stable grains, ≈ +35% on high-cardinality
 * dims), so the UI presents bands. The real figure lands after the rebuild.
 */

const MB = 1024 * 1024;

/** A candidate grain is too expensive for the rollup when a single monthly
 *  partition would exceed this. Matches §8's "a partition > 50 MB". */
export const RAW_ONLY_PARTITION_BYTES = 50 * MB;
/** …or when the candidate grain is more than this multiple of the current
 *  rollup (§8's "> 2× current rollup"). */
export const RAW_ONLY_GROWTH_FACTOR = 2;
/** A single dimension is raw-only when its distinct-value count exceeds this
 *  fraction of the month's line items — at that point it provides almost no
 *  aggregation, so it belongs in raw, not the rollup. Catches `resource_id`
 *  (≈ unique per line item) even on tiny datasets where the byte threshold
 *  never trips. */
export const RAW_ONLY_COMPRESSION_FLOOR = 0.5;
/** A dimension with at least this many distinct values is a high-cardinality
 *  driver: it multiplies the grain enough to be a primary contributor to rollup
 *  size, so it's flagged for the user even when the whole-grain byte/growth
 *  thresholds are reached by a *combination* of dims rather than this one alone.
 *  This is what surfaces `resource_id` / `usage_type` / `operation` as the
 *  dims to consider keeping raw-only — data-driven, not a hardcoded list.
 *  Navigational dims (account, region, service, tags) sit far below it. */
export const HIGH_CARDINALITY_VALUES = 1000;
/** Fallback bytes-per-rollup-row when there is no built rollup to measure
 *  against (≈ the measured 266 MB / 19.6M rows from the design appendix). */
export const DEFAULT_BYTES_PER_ROW = 16;

const REBUILD_BASE_SECONDS_PER_PARTITION = 2;
const REBUILD_SECONDS_PER_ROW = 0.0000048;

export type RollupSizeBand = 'tiny' | 'small' | 'moderate' | 'large' | 'huge';
export type RollupRebuildBand = 'instant' | 'fast' | 'moderate' | 'slow';

export interface RollupCurrentStats {
  readonly rows: number;
  readonly bytes: number;
}

/** The raw dataset baseline the rollup is derived from — the reference point
 *  for "how much smaller is the rollup". `rows` is the line-item count over the
 *  window; `bytes` is the actual on-disk size of the raw daily Parquet. */
export interface RollupRawStats {
  readonly rows: number;
  readonly bytes: number;
}

/** Per-dimension cardinality + whether it's flagged as a high-cardinality
 *  driver of rollup size (the amber badge in the UI). */
export interface RollupDimEstimate {
  readonly column: string;
  readonly cardinality: number;
  readonly rawOnly: boolean;
}

export interface RollupGrainEstimate {
  /** YYYY-MM the candidate was probed from; '' when there is no data on disk. */
  readonly probePeriod: string;
  /** Months of raw data on disk — scales the per-month probe to a window total. */
  readonly months: number;
  /** Line items in the probe month (the rollup's raw input for that month). */
  readonly lineItems: number;
  /** The raw dataset the rollup compresses — shown as the size/row baseline so
   *  the estimated rollup figures are comparable to something concrete. */
  readonly raw: RollupRawStats;
  /** Exact totals summed from the on-disk rollup manifest; null when none built. */
  readonly current: RollupCurrentStats | null;
  readonly candidate: {
    readonly rows: number;
    readonly bytes: number;
    readonly perPartitionBytes: number;
    readonly sizeBand: RollupSizeBand;
    readonly rebuildSeconds: number;
    readonly rebuildBand: RollupRebuildBand;
    /** candidate.rows ÷ current.rows, or null when there is no current rollup. */
    readonly growthFactor: number | null;
  };
  /** Line items ÷ rollup rows — how much the rollup compresses the raw data. */
  readonly compressionRate: number;
  readonly rawOnly: { readonly recommended: boolean; readonly reason: string | null };
  readonly dims: readonly RollupDimEstimate[];
}

export interface RollupEstimateInput {
  readonly probePeriod: string;
  readonly months: number;
  /** approx_count_distinct over the candidate grain tuple in the probe month. */
  readonly probeGrainRows: number;
  /** COUNT(*) in the probe month. */
  readonly probeLineItems: number;
  /** Actual on-disk size of the raw daily Parquet across the whole window. */
  readonly rawBytes: number;
  readonly current: RollupCurrentStats | null;
  readonly dimCardinalities: readonly { readonly column: string; readonly cardinality: number }[];
}

export function estimateBytesPerRow(current: RollupCurrentStats | null): number {
  return current !== null && current.rows > 0 ? current.bytes / current.rows : DEFAULT_BYTES_PER_ROW;
}

/** Whether a single dimension is a high-cardinality driver worth flagging:
 *  - it alone would blow past the per-partition byte budget, or
 *  - it barely aggregates (distinct values approach the line-item count — e.g.
 *    `resource_id`), or
 *  - it simply has many distinct values, making it a primary contributor to
 *    rollup size whenever the grain as a whole is heavy (`usage_type`,
 *    `operation`, …). The navigational dims sit far below `HIGH_CARDINALITY_VALUES`. */
export function isDimRawOnly(cardinality: number, lineItems: number, bytesPerRow: number): boolean {
  if (cardinality * bytesPerRow > RAW_ONLY_PARTITION_BYTES) return true;
  if (lineItems > 0 && cardinality > lineItems * RAW_ONLY_COMPRESSION_FLOOR) return true;
  if (cardinality >= HIGH_CARDINALITY_VALUES) return true;
  return false;
}

export function classifySizeBand(bytes: number): RollupSizeBand {
  if (bytes < 5 * MB) return 'tiny';
  if (bytes < 50 * MB) return 'small';
  if (bytes < 250 * MB) return 'moderate';
  if (bytes < 1024 * MB) return 'large';
  return 'huge';
}

export function classifyRebuildBand(seconds: number): RollupRebuildBand {
  if (seconds < 5) return 'instant';
  if (seconds < 30) return 'fast';
  if (seconds < 120) return 'moderate';
  return 'slow';
}

export function computeRollupEstimate(input: RollupEstimateInput): RollupGrainEstimate {
  const months = Math.max(1, input.months);
  const bytesPerRow = estimateBytesPerRow(input.current);
  const perPartitionRows = input.probeGrainRows;
  const perPartitionBytes = perPartitionRows * bytesPerRow;
  const rows = perPartitionRows * months;
  const bytes = rows * bytesPerRow;
  const rebuildSeconds = months * REBUILD_BASE_SECONDS_PER_PARTITION + rows * REBUILD_SECONDS_PER_ROW;
  const compressionRate = perPartitionRows > 0 ? input.probeLineItems / perPartitionRows : 0;
  const growthFactor = input.current !== null && input.current.rows > 0 ? rows / input.current.rows : null;

  const dims = input.dimCardinalities.map(d => ({
    column: d.column,
    cardinality: d.cardinality,
    rawOnly: isDimRawOnly(d.cardinality, input.probeLineItems, bytesPerRow),
  }));
  const flaggedCount = dims.filter(d => d.rawOnly).length;

  const byPartition = perPartitionBytes > RAW_ONLY_PARTITION_BYTES;
  const byGrowth = growthFactor !== null && growthFactor > RAW_ONLY_GROWTH_FACTOR;
  // Fallback message for a grain that's heavy without any single high-card dim
  // to point at; when dims ARE flagged the UI names them instead.
  const reason = byPartition
    ? `a monthly partition would be ~${String(Math.round(perPartitionBytes / MB))} MB — over the ${String(Math.round(RAW_ONLY_PARTITION_BYTES / MB))} MB raw-only threshold`
    : byGrowth
      ? `this grain is ~${growthFactor.toFixed(1)}× the current rollup`
      : null;

  return {
    probePeriod: input.probePeriod,
    months,
    lineItems: input.probeLineItems,
    raw: { rows: input.probeLineItems * months, bytes: input.rawBytes },
    current: input.current,
    candidate: {
      rows,
      bytes,
      perPartitionBytes,
      sizeBand: classifySizeBand(bytes),
      rebuildSeconds,
      rebuildBand: classifyRebuildBand(rebuildSeconds),
      growthFactor,
    },
    compressionRate,
    rawOnly: { recommended: byPartition || byGrowth || flaggedCount > 0, reason },
    dims,
  };
}

/** The estimate returned when there is no data on disk to probe. */
export function emptyRollupEstimate(current: RollupCurrentStats | null): RollupGrainEstimate {
  return {
    probePeriod: '',
    months: 0,
    lineItems: 0,
    raw: { rows: 0, bytes: 0 },
    current,
    candidate: {
      rows: 0,
      bytes: 0,
      perPartitionBytes: 0,
      sizeBand: 'tiny',
      rebuildSeconds: 0,
      rebuildBand: 'instant',
      growthFactor: null,
    },
    compressionRate: 0,
    rawOnly: { recommended: false, reason: null },
    dims: [],
  };
}
