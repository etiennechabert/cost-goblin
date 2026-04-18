import { describe, expect, it } from 'vitest';
import {
  extractDate,
  extractPeriod,
  extractPeriodPrefix,
  getEtagFileName,
  groupByPeriod,
  parseEtagsJson,
} from '../sync/sync-utils.js';
import type { ManifestFileEntry } from '../sync/manifest.js';

const file = (key: string, hash = 'h', size = 1): ManifestFileEntry => ({ key, contentHash: hash, size });

describe('extractPeriod', () => {
  it('extracts BILLING_PERIOD from CUR keys', () => {
    expect(extractPeriod('cur/data/BILLING_PERIOD=2026-03/file.parquet')).toBe('2026-03');
  });

  it('extracts year-month from date= keys (cost optimization)', () => {
    expect(extractPeriod('cost-opt/date=2026-03-15/file.parquet')).toBe('2026-03');
  });

  it('returns "unknown" for unrecognized keys', () => {
    expect(extractPeriod('random/path/file.parquet')).toBe('unknown');
  });
});

describe('extractPeriodPrefix', () => {
  it('extracts the path up to and including BILLING_PERIOD=', () => {
    expect(extractPeriodPrefix('cur/data/BILLING_PERIOD=2026-03/file.parquet'))
      .toBe('cur/data/BILLING_PERIOD=2026-03/');
  });

  it('extracts the path up to and including date= for cost optimization', () => {
    expect(extractPeriodPrefix('cost-opt/data/date=2026-03-15/file.parquet'))
      .toBe('cost-opt/data/date=2026-03-15/');
  });

  it('returns empty string when no period marker found', () => {
    expect(extractPeriodPrefix('random/path/file.parquet')).toBe('');
  });
});

describe('extractDate', () => {
  it('extracts date from date= prefix', () => {
    expect(extractDate('cost-opt/date=2026-03-15/file.parquet')).toBe('2026-03-15');
  });

  it('returns undefined when no date marker found', () => {
    expect(extractDate('cur/BILLING_PERIOD=2026-03/file.parquet')).toBeUndefined();
  });
});

describe('groupByPeriod', () => {
  it('groups files by their billing period', () => {
    const files = [
      file('cur/BILLING_PERIOD=2026-01/a.parquet'),
      file('cur/BILLING_PERIOD=2026-01/b.parquet'),
      file('cur/BILLING_PERIOD=2026-02/c.parquet'),
    ];
    const groups = groupByPeriod(files);
    expect(groups.size).toBe(2);
    expect(groups.get('2026-01')).toHaveLength(2);
    expect(groups.get('2026-02')).toHaveLength(1);
  });

  it('places unrecognized keys under "unknown"', () => {
    const groups = groupByPeriod([file('random/file.parquet')]);
    expect(groups.get('unknown')).toHaveLength(1);
  });

  it('returns empty map for empty input', () => {
    expect(groupByPeriod([]).size).toBe(0);
  });
});

describe('getEtagFileName', () => {
  it('returns the per-tier filename', () => {
    expect(getEtagFileName('daily')).toBe('sync-etags.json');
    expect(getEtagFileName('hourly')).toBe('sync-etags-hourly.json');
    expect(getEtagFileName('cost-optimization')).toBe('sync-etags-cost-optimization.json');
  });

  it('falls back to the daily filename for unknown tiers', () => {
    expect(getEtagFileName('bogus')).toBe('sync-etags.json');
  });
});

describe('parseEtagsJson', () => {
  it('parses a well-formed nested record', () => {
    const json = JSON.stringify({
      '2026-01': { 'a.parquet': 'h1', 'b.parquet': 'h2' },
      '2026-02': { 'c.parquet': 'h3' },
    });
    const result = parseEtagsJson(json);
    expect(result['2026-01']).toEqual({ 'a.parquet': 'h1', 'b.parquet': 'h2' });
    expect(result['2026-02']).toEqual({ 'c.parquet': 'h3' });
  });

  it('returns empty record on invalid JSON', () => {
    expect(parseEtagsJson('not json')).toEqual({});
  });

  it('returns empty record when top-level is not an object', () => {
    expect(parseEtagsJson('[]')).toEqual({});
    expect(parseEtagsJson('null')).toEqual({});
    expect(parseEtagsJson('"string"')).toEqual({});
  });

  it('skips period entries that are not objects', () => {
    const json = JSON.stringify({
      '2026-01': { 'a.parquet': 'h1' },
      '2026-02': 'not-an-object',
    });
    const result = parseEtagsJson(json);
    expect(result['2026-01']).toEqual({ 'a.parquet': 'h1' });
    expect(result['2026-02']).toBeUndefined();
  });

  it('drops non-string hash values within a period', () => {
    const json = JSON.stringify({
      '2026-01': { 'a.parquet': 'h1', 'b.parquet': 42, 'c.parquet': null },
    });
    const result = parseEtagsJson(json);
    expect(result['2026-01']).toEqual({ 'a.parquet': 'h1' });
  });
});
