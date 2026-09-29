import { describe, it, expect } from 'vitest';
import { ConfigValidationError } from '@costgoblin/core';
import { parseDimensionsPayload, parseDimensionsSavePayload } from '../main/handlers/dimensions-payload.js';
import { DEFAULT_BUILT_INS } from '../main/handlers/dimensions-merge.js';
import { rawGlobLiteral } from '../main/handlers/query-utils.js';

/** The dimensions IPC handlers (save-config, estimate-rollup-grain) receive
 *  renderer input. Everything they hand to fs or DuckDB must first pass the
 *  same validator a dimensions.yaml does. */
describe('parseDimensionsPayload', () => {
  it.each([
    ['null', null],
    ['an empty object', {}],
    ['a string', 'builtIn'],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseDimensionsPayload(payload)).toThrow(ConfigValidationError);
  });

  it('rejects a built-in field that is not a bare identifier', () => {
    expect(() => parseDimensionsPayload({
      builtIn: [{ name: 'service', label: 'Service', field: 'service) OR (1=1' }],
      tags: [],
    })).toThrow(ConfigValidationError);
  });

  it('rejects a built-in displayField that is not a bare identifier', () => {
    expect(() => parseDimensionsPayload({
      builtIn: [{ name: 'account', label: 'Account', field: 'account_id', displayField: "account_name'" }],
      tags: [],
    })).toThrow(ConfigValidationError);
  });

  it.each([0, 1.5, '1'])('rejects pathSegment.index %s', (index) => {
    expect(() => parseDimensionsPayload({
      builtIn: [],
      tags: [{ label: 'OU', accountTagFallback: '__ouPath__', pathSegment: { separator: '/', index } }],
    })).toThrow(ConfigValidationError);
  });

  it('rejects a tag with neither a tag key nor an account fallback', () => {
    expect(() => parseDimensionsPayload({ builtIn: [], tags: [{ label: 'Draft' }] })).toThrow(ConfigValidationError);
  });

  it('returns the default built-ins unchanged', () => {
    const payload = { builtIn: [...DEFAULT_BUILT_INS], tags: [] };
    expect(parseDimensionsPayload(payload)).toEqual(payload);
  });

  describe('nameStripPatterns caps', () => {
    function withPatterns(nameStripPatterns: readonly string[]): unknown {
      return { builtIn: [{ name: 'account', label: 'Account', field: 'account_id', nameStripPatterns }], tags: [] };
    }
    const seventeen = Array.from({ length: 17 }, (_, i) => `^p${String(i)}-`);

    it('rejects an over-limit list when saving', () => {
      expect(() => parseDimensionsSavePayload(withPatterns(seventeen))).toThrow(ConfigValidationError);
      expect(() => parseDimensionsSavePayload(withPatterns(['x'.repeat(257)]))).toThrow(ConfigValidationError);
    });

    it('accepts a list within the caps when saving', () => {
      expect(parseDimensionsSavePayload(withPatterns(['^acme-'])).builtIn[0]?.nameStripPatterns).toEqual(['^acme-']);
    });

    it('still runs every other check when saving', () => {
      expect(() => parseDimensionsSavePayload({ builtIn: [], tags: [{ label: 'Draft' }] })).toThrow(ConfigValidationError);
    });

    it('drops the excess for a non-persisted payload (the estimate probe, whose SQL never sees the patterns)', () => {
      expect(parseDimensionsPayload(withPatterns(seventeen)).builtIn[0]?.nameStripPatterns).toHaveLength(16);
    });
  });
});

describe('rawGlobLiteral', () => {
  it('builds a quoted raw-tier glob literal', () => {
    expect(rawGlobLiteral('/data', 'aws', 'daily-*/*.parquet')).toBe("'/data/aws/raw/daily-*/*.parquet'");
  });

  it('escapes single quotes in the data dir', () => {
    expect(rawGlobLiteral("/Users/o'brien/data", 'aws', 'daily-2026-01/*.parquet'))
      .toBe("'/Users/o''brien/data/aws/raw/daily-2026-01/*.parquet'");
  });
});
