import { describe, it, expect } from 'vitest';
import {
  computeRollupEstimate,
  emptyRollupEstimate,
  isDimRawOnly,
  estimateBytesPerRow,
  classifySizeBand,
  classifyRebuildBand,
  RAW_ONLY_PARTITION_BYTES,
  DEFAULT_BYTES_PER_ROW,
} from '../rollup/estimator.js';

const MB = 1024 * 1024;

describe('estimateBytesPerRow', () => {
  it('derives bytes/row from the current rollup when present', () => {
    expect(estimateBytesPerRow({ rows: 1000, bytes: 20000 })).toBe(20);
  });
  it('falls back to the default when there is no rollup', () => {
    expect(estimateBytesPerRow(null)).toBe(DEFAULT_BYTES_PER_ROW);
    expect(estimateBytesPerRow({ rows: 0, bytes: 0 })).toBe(DEFAULT_BYTES_PER_ROW);
  });
});

describe('classifySizeBand', () => {
  it('buckets bytes into bands', () => {
    expect(classifySizeBand(4 * MB)).toBe('tiny');
    expect(classifySizeBand(6 * MB)).toBe('small');
    expect(classifySizeBand(100 * MB)).toBe('moderate');
    expect(classifySizeBand(500 * MB)).toBe('large');
    expect(classifySizeBand(2048 * MB)).toBe('huge');
  });
});

describe('classifyRebuildBand', () => {
  it('buckets seconds into bands', () => {
    expect(classifyRebuildBand(3)).toBe('instant');
    expect(classifyRebuildBand(10)).toBe('fast');
    expect(classifyRebuildBand(60)).toBe('moderate');
    expect(classifyRebuildBand(200)).toBe('slow');
  });
});

describe('isDimRawOnly', () => {
  it('flags a dim whose distinct count approaches the line-item count', () => {
    // resource_id-class: ~unique per line item destroys compression.
    expect(isDimRawOnly(1_820_000, 2_100_000, 16)).toBe(true);
  });
  it('keeps a low-cardinality dim', () => {
    expect(isDimRawOnly(38, 2_100_000, 16)).toBe(false);
    expect(isDimRawOnly(900, 50_000_000, 16)).toBe(false); // just under the high-card floor
  });
  it('flags a high-cardinality dim even when it compresses fine alone', () => {
    // usage_type-class: many values, a primary driver when combined with others.
    expect(isDimRawOnly(5_000, 50_000_000, 16)).toBe(true);
  });
  it('flags on absolute partition bytes even without a line-item baseline', () => {
    // 4M distinct × 16 bytes = 64 MB > 50 MB threshold.
    expect(isDimRawOnly(4_000_000, 0, 16)).toBe(true);
  });
});

describe('computeRollupEstimate', () => {
  it('reports a stable grain as not raw-only with healthy compression', () => {
    const e = computeRollupEstimate({
      probePeriod: '2026-04',
      months: 12,
      probeGrainRows: 92_000,
      probeLineItems: 2_100_000,
      rawBytes: 4_900_000_000,
      current: { rows: 1_100_000, bytes: 17_600_000 },
      dimCardinalities: [
        { column: 'account_id', cardinality: 14 },
        { column: 'service', cardinality: 38 },
      ],
    });
    expect(e.candidate.rows).toBe(92_000 * 12);
    expect(e.candidate.sizeBand).toBe('small');
    expect(e.compressionRate).toBeCloseTo(2_100_000 / 92_000, 1);
    expect(e.rawOnly.recommended).toBe(false);
    expect(e.dims.every(d => !d.rawOnly)).toBe(true);
    expect(e.candidate.growthFactor).toBeCloseTo((92_000 * 12) / 1_100_000, 2);
    // Raw baseline: line items × months, with the actual on-disk byte size.
    expect(e.raw.rows).toBe(2_100_000 * 12);
    expect(e.raw.bytes).toBe(4_900_000_000);
  });

  it('recommends raw-only when a monthly partition exceeds the byte threshold', () => {
    const e = computeRollupEstimate({
      probePeriod: '2026-04',
      months: 12,
      probeGrainRows: 5_000_000, // × 16 bytes = 80 MB/partition
      probeLineItems: 6_000_000,
      rawBytes: 30_000_000_000,
      current: null,
      dimCardinalities: [{ column: 'resource_id', cardinality: 5_000_000 }],
    });
    expect(e.candidate.perPartitionBytes).toBeGreaterThan(RAW_ONLY_PARTITION_BYTES);
    expect(e.rawOnly.recommended).toBe(true);
    expect(e.rawOnly.reason).toContain('MB');
    expect(e.dims[0]?.rawOnly).toBe(true);
  });

  it('recommends raw-only when the grain is more than 2× the current rollup', () => {
    const e = computeRollupEstimate({
      probePeriod: '2026-04',
      months: 1,
      probeGrainRows: 300_000, // 4.8 MB/partition — under the byte threshold
      probeLineItems: 1_000_000,
      rawBytes: 2_000_000_000,
      current: { rows: 100_000, bytes: 1_600_000 },
      // A low-cardinality dim so neither the byte nor the high-card per-dim rule
      // fires — the recommendation comes purely from the 3× growth.
      dimCardinalities: [{ column: 'region', cardinality: 200 }],
    });
    expect(e.candidate.perPartitionBytes).toBeLessThan(RAW_ONLY_PARTITION_BYTES);
    expect(e.candidate.growthFactor).toBeCloseTo(3, 1);
    expect(e.rawOnly.recommended).toBe(true);
    expect(e.rawOnly.reason).toContain('×');
    // The single 200-cardinality dim is not itself raw-only.
    expect(e.dims[0]?.rawOnly).toBe(false);
  });

  it('treats months as at least 1', () => {
    const e = computeRollupEstimate({
      probePeriod: '2026-04', months: 0, probeGrainRows: 1000, probeLineItems: 10_000, rawBytes: 0, current: null, dimCardinalities: [],
    });
    expect(e.months).toBe(1);
    expect(e.candidate.rows).toBe(1000);
  });
});

describe('emptyRollupEstimate', () => {
  it('carries the current stats but reports no probe', () => {
    const e = emptyRollupEstimate({ rows: 10, bytes: 160 });
    expect(e.probePeriod).toBe('');
    expect(e.current).toEqual({ rows: 10, bytes: 160 });
    expect(e.raw).toEqual({ rows: 0, bytes: 0 });
    expect(e.rawOnly.recommended).toBe(false);
    expect(e.dims).toEqual([]);
  });
});
