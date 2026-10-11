import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractDate,
  extractPeriod,
  extractPeriodPrefix,
  groupByPeriod,
  isCreateNewDeliveryKey,
  isPartitionFolderName,
  listLocalMonths,
  parseAwsCompletedBytes,
  parseEtagsJson,
  parsePartition,
} from '../sync/sync-utils.js';
import type { ManifestFileEntry } from '../sync/manifest.js';
import { asProviderName } from '../types/branded.js';

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

describe('parsePartition', () => {
  it.each([
    ['cost-opt/date=2026-03-15/f.parquet', 'cost-opt/date=2026-03-15/'],
    ['cost-opt/data/date=2026-03-15/f.snappy.parquet', 'cost-opt/data/date=2026-03-15/'],
    ['date=2026-03-15/f.parquet', 'date=2026-03-15/'],
    // The documented Cost Optimization Hub layout: a date= FOLDER holding the parts.
    ['coh/cost-optimization-recommendations/data/date=2026-03-15/part-00000-0a1b2c.snappy.parquet',
      'coh/cost-optimization-recommendations/data/date=2026-03-15/'],
  ])('accepts cost-optimization key %s', (key, prefix) => {
    expect(parsePartition(key, 'cost-optimization')).toEqual({
      kind: 'date', prefix, period: '2026-03', date: '2026-03-15',
    });
  });

  it.each(['daily', 'hourly'] as const)('accepts a %s billing_period= folder', (tier) => {
    expect(parsePartition('f/data/billing_period=2026-03/x.snappy.parquet', tier)).toEqual({
      kind: 'billing-period', prefix: 'f/data/billing_period=2026-03/', period: '2026-03',
    });
  });

  it('takes the partition from the LAST folder segment, never an earlier one', () => {
    expect(parsePartition('cost-opt/update_date=2025-12-31/date=2026-01-01/x.parquet', 'cost-optimization')).toEqual({
      kind: 'date', prefix: 'cost-opt/update_date=2025-12-31/date=2026-01-01/', period: '2026-01', date: '2026-01-01',
    });
  });

  it.each([
    // date= in the file name: the source used to collapse to the bucket root.
    'cost-opt/date=2026-01-01_part-0.parquet',
    // substring match on a different column name
    'cost-opt/usage_date=2026-01-02/x.parquet',
    // a folder that merely starts with a date
    'cost-opt/date=2026-01-01-v2/x.parquet',
    // used to pull the whole billing_period folder
    'cost-opt/billing_period=2026-01/date=2026-01-04_x.parquet',
    'cost-opt/date=2026-01-01/',
    'x.parquet',
  ])('rejects cost-optimization key %s', (key) => {
    expect(parsePartition(key, 'cost-optimization')).toBeNull();
  });

  it.each([
    // CUR-era uppercase stays invisible
    'cur/BILLING_PERIOD=2026-03/x.parquet',
    'f/billing_period=2026-01_shard0.parquet',
    'cur/old_billing_period=2026-01/x.parquet',
    // no date= fallback for the daily/hourly tiers
    'cur/usage_date=2026-01-02/x.parquet',
    'cost-opt/date=2026-03-15/f.parquet',
    'cur/billing_period=2026-01/sub/x.parquet',
    'billing_period=2026-01',
  ])('rejects daily key %s', (key) => {
    expect(parsePartition(key, 'daily')).toBeNull();
    expect(parsePartition(key, 'hourly')).toBeNull();
  });
});

// AWS documents a "Create new data export file" delivery as
// `data/<partition>/<timestamp>-<execution-id>/<file>`. The folder's exact
// spelling isn't documented, so only its position is relied on.
describe('isCreateNewDeliveryKey', () => {
  it.each(['daily', 'hourly'] as const)('recognises a %s refresh delivered into its own folder below billing_period=', (tier) => {
    const key = 'focus_daily/focus-daily/data/billing_period=2026-09/20260915T040512Z-3f2a9c1e/focus-daily-00001.snappy.parquet';
    expect(isCreateNewDeliveryKey(key, tier)).toBe(true);
    // The key sync can never read: the guard exists because of this.
    expect(parsePartition(key, tier)).toBeNull();
  });

  it('recognises a cost-optimization refresh delivered into its own folder below date=', () => {
    expect(isCreateNewDeliveryKey('coh/data/date=2026-09-15/20260915T040512Z-3f2a9c1e/part-0.snappy.parquet', 'cost-optimization')).toBe(true);
  });

  it.each([
    // the Overwrite layout sync reads
    ['daily', 'focus/data/billing_period=2026-09/focus-00001.snappy.parquet'],
    ['cost-optimization', 'coh/data/date=2026-09-15/part-0.snappy.parquet'],
    // two levels below the partition: not the documented shape
    ['daily', 'focus/data/billing_period=2026-09/a/b/x.parquet'],
    // a folder below another tier's partition
    ['daily', 'coh/data/date=2026-09-15/run-1/part-0.parquet'],
    ['cost-optimization', 'focus/data/billing_period=2026-09/run-1/x.parquet'],
    // CUR-era uppercase stays invisible here too
    ['daily', 'cur/data/BILLING_PERIOD=2026-09/run-1/x.parquet'],
    // a nested partition folder is a partition, not a delivery folder
    ['daily', 'focus/billing_period=2026-09/billing_period=2026-09/x.parquet'],
    // no file name
    ['daily', 'focus/data/billing_period=2026-09/run-1/'],
    ['daily', 'focus/data/billing_period=2026-09//x.parquet'],
    ['daily', 'run-1/x.parquet'],
  ] as const)('rejects %s key %s', (tier, key) => {
    expect(isCreateNewDeliveryKey(key, tier)).toBe(false);
  });
});

describe('isPartitionFolderName', () => {
  it.each(['billing_period=2026-09', 'date=2026-09-15'])('accepts %s', (name) => {
    expect(isPartitionFolderName(name)).toBe(true);
  });

  it.each(['BILLING_PERIOD=2026-09', 'billing_period=2026-9', 'date=2026-09', 'date=2026-09-15-v2', 'data', ''])('rejects %s', (name) => {
    expect(isPartitionFolderName(name)).toBe(false);
  });
});

describe('listLocalMonths', () => {
  const provider = asProviderName('aws-main');
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'costgoblin-local-months-'));
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function periodDir(name: string, files: readonly string[]): Promise<void> {
    const dir = join(dataDir, 'aws-main', 'raw', name);
    await mkdir(dir, { recursive: true });
    for (const file of files) await writeFile(join(dir, file), '');
  }

  it('lists sorted months whose dir holds at least one parquet file', async () => {
    await periodDir('daily-2026-04', ['part-0.parquet']);
    await periodDir('daily-2026-02', ['a.parquet', 'b.parquet']);
    await periodDir('daily-2026-03', []);
    await periodDir('daily-2026-05', ['notes.txt']);
    await periodDir('daily-bogus', ['x.parquet']);
    await periodDir('hourly-2026-01', ['h.parquet']);

    expect(await listLocalMonths(dataDir, provider, 'daily')).toEqual(['2026-02', '2026-04']);
    expect(await listLocalMonths(dataDir, provider, 'hourly')).toEqual(['2026-01']);
  });

  it('collapses cost-optimization date dirs to one YYYY-MM under the cost-opt prefix', async () => {
    await periodDir('cost-opt-2026-04-08', ['c.parquet']);
    await periodDir('cost-opt-2026-04-09', ['c.parquet']);

    expect(await listLocalMonths(dataDir, provider, 'cost-optimization')).toEqual(['2026-04']);
  });

  it('returns an empty list when the provider has no raw dir', async () => {
    expect(await listLocalMonths(dataDir, provider, 'daily')).toEqual([]);
  });
});
