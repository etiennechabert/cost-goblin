import { describe, expect, it } from 'vitest';
import {
  extractDate,
  extractPeriod,
  extractPeriodPrefix,
  groupByPeriod,
  parseAwsCompletedBytes,
  parseEtagsJson,
} from '../sync/sync-utils.js';
import type { ManifestFileEntry } from '../sync/manifest.js';

const file = (key: string, hash = 'h', size = 1): ManifestFileEntry => ({ key, contentHash: hash, size });

describe('extractPeriod', () => {
  it('extracts billing_period from FOCUS export keys', () => {
    expect(extractPeriod('focus/daily/data/billing_period=2026-03/daily-00001.snappy.parquet')).toBe('2026-03');
  });

  it('ignores CUR-era uppercase BILLING_PERIOD keys (leftover CUR data must stay invisible)', () => {
    expect(extractPeriod('cur/data/BILLING_PERIOD=2026-03/file.parquet')).toBe('unknown');
  });

  it('extracts year-month from date= keys (cost optimization)', () => {
    expect(extractPeriod('cost-opt/date=2026-03-15/file.parquet')).toBe('2026-03');
  });

  it('returns "unknown" for unrecognized keys', () => {
    expect(extractPeriod('random/path/file.parquet')).toBe('unknown');
  });
});

describe('extractPeriodPrefix', () => {
  it('extracts the path up to and including billing_period=', () => {
    expect(extractPeriodPrefix('focus/daily/data/billing_period=2026-03/daily-00001.snappy.parquet'))
      .toBe('focus/daily/data/billing_period=2026-03/');
  });

  it('returns empty string for CUR-era uppercase BILLING_PERIOD keys', () => {
    expect(extractPeriodPrefix('cur/data/BILLING_PERIOD=2026-03/file.parquet')).toBe('');
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
    expect(extractDate('focus/daily/data/billing_period=2026-03/file.parquet')).toBeUndefined();
  });
});

describe('groupByPeriod', () => {
  it('groups files by their billing period', () => {
    const files = [
      file('focus/daily/data/billing_period=2026-01/a.parquet'),
      file('focus/daily/data/billing_period=2026-01/b.parquet'),
      file('focus/daily/data/billing_period=2026-02/c.parquet'),
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

describe('parseAwsCompletedBytes', () => {
  it('parses MiB/MiB with rate and remaining', () => {
    const result = parseAwsCompletedBytes('Completed 203.6 MiB/404.2 MiB (3.0 MiB/s) with 7 file(s) remaining');
    expect(result).not.toBeNull();
    expect(result?.bytesDone).toBeCloseTo(203.6 * 1024 * 1024, 0);
    expect(result?.bytesTotal).toBeCloseTo(404.2 * 1024 * 1024, 0);
  });

  it('parses GiB units', () => {
    const result = parseAwsCompletedBytes('Completed 1.5 GiB/2.0 GiB (10.0 MiB/s) with 3 file(s) remaining');
    expect(result?.bytesDone).toBeCloseTo(1.5 * 1024 ** 3, 0);
    expect(result?.bytesTotal).toBeCloseTo(2.0 * 1024 ** 3, 0);
  });

  it('parses mixed units (KiB / MiB)', () => {
    const result = parseAwsCompletedBytes('Completed 512.0 KiB/1.0 MiB (100.0 KiB/s) with 1 file(s) remaining');
    expect(result?.bytesDone).toBe(512 * 1024);
    expect(result?.bytesTotal).toBe(1024 * 1024);
  });

  it('returns null for the file-count-only form (no bytes available)', () => {
    expect(parseAwsCompletedBytes('Completed 5 file(s) with 2 file(s) remaining')).toBeNull();
  });

  it('returns null for non-Completed lines', () => {
    expect(parseAwsCompletedBytes('download: s3://bucket/k to /local/k')).toBeNull();
    expect(parseAwsCompletedBytes('')).toBeNull();
  });

  it('returns null when total is zero', () => {
    expect(parseAwsCompletedBytes('Completed 0 B/0 B (0 B/s) with 0 file(s) remaining')).toBeNull();
  });
});
