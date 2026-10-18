import { describe, it, expect } from 'vitest';
import { canonicalJson } from '../rollup/digest.js';
import { computeRollupEstimate } from '../rollup/estimator.js';
import { rollupGrainColumns, rollupGrainDimensions } from '../rollup/grain.js';
import { asDimensionId, tagSqlColumn } from '../types/branded.js';
import type { DimensionsConfig, TagDimension } from '../types/config.js';

describe('computeRollupEstimate on a probe month with no rows', () => {
  it('reports no compression and no inflation instead of NaN or Infinity', () => {
    const estimate = computeRollupEstimate({
      probePeriod: '2026-06',
      months: 3,
      probeGrainRows: 0,
      probeLineItems: 0,
      rawBytes: 0,
      current: null,
      dimCardinalities: [
        { column: 'account_id', cardinality: 0, leaveOneOutGrainRows: 0 },
        { column: 'service', cardinality: 0, leaveOneOutGrainRows: 0 },
      ],
    });
    expect(estimate.compressionRate).toBe(0);
    expect(estimate.candidate).toEqual({
      rows: 0,
      bytes: 0,
      perPartitionBytes: 0,
      sizeBand: 'tiny',
      // Only the fixed per-partition cost: 3 months × 2 s.
      rebuildSeconds: 6,
      rebuildBand: 'fast',
      growthFactor: null,
    });
    const quiet = { cardinality: 0, rawOnly: false, marginalMultiplier: 1, marginalRows: 0, impactShare: 0, outlier: false };
    expect(estimate.dims).toEqual([{ column: 'account_id', ...quiet }, { column: 'service', ...quiet }]);
    expect(estimate.rawOnly).toEqual({ recommended: false, reason: null });
  });
});

describe('rollup grain with a disabled tag dimension', () => {
  const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
  const dims: DimensionsConfig = {
    builtIn: [{ name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' }],
    tags: [TEAM, { tagName: 'env', label: 'Environment', enabled: false }],
  };
  const teamColumn = tagSqlColumn(TEAM);

  it('leaves its column out of the stored grain', () => {
    expect(rollupGrainColumns(dims)).toEqual(['usage_date', 'account_id', 'account_name', teamColumn]);
  });

  it('leaves it out of the per-dimension grain groups', () => {
    expect(rollupGrainDimensions(dims)).toEqual([
      { column: 'account_id', columns: ['account_id', 'account_name'] },
      { column: teamColumn, columns: [teamColumn] },
    ]);
  });
});

describe('canonicalJson and undefined', () => {
  it('writes undefined as null, at the top level, in objects and in arrays', () => {
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson({ b: undefined, a: 1 })).toBe('{"a":1,"b":null}');
    expect(canonicalJson([undefined, 1])).toBe('[null,1]');
  });

  it('digests an optional field left undefined like one set to null', () => {
    expect(canonicalJson({ tagName: undefined, column: 'c' })).toBe(canonicalJson({ column: 'c', tagName: null }));
  });
});
