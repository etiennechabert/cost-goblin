import { describe, expect, it } from 'vitest';
import { classifyFileVersioning, newestPartitionFolder } from '../main/setup-file-versioning.js';

describe('newestPartitionFolder', () => {
  it('picks the newest billing_period= folder of a delimited data/ listing', () => {
    expect(newestPartitionFolder([
      'focus/daily/data/billing_period=2026-08/',
      'focus/daily/data/billing_period=2026-10/',
      'focus/daily/data/billing_period=2026-09/',
    ])).toBe('focus/daily/data/billing_period=2026-10/');
  });

  it('picks the newest date= folder of a cost-optimization export', () => {
    expect(newestPartitionFolder(['coh/data/date=2026-10-01/', 'coh/data/date=2026-10-02/'])).toBe('coh/data/date=2026-10-02/');
  });

  it('ignores folders that are not partitions, CUR-era uppercase included', () => {
    expect(newestPartitionFolder(['cur/data/BILLING_PERIOD=2026-10/', 'cur/data/tmp/', 'cur/data/billing_period=2026-09/']))
      .toBe('cur/data/billing_period=2026-09/');
    expect(newestPartitionFolder(['cur/data/BILLING_PERIOD=2026-10/'])).toBeUndefined();
  });

  it('has no answer for an export with no delivery yet', () => {
    expect(newestPartitionFolder([])).toBeUndefined();
  });
});

describe('classifyFileVersioning', () => {
  it('reads Parquet sitting in the partition folder itself as Overwrite', () => {
    expect(classifyFileVersioning({
      fileKeys: ['focus/data/billing_period=2026-10/focus-00001.snappy.parquet'],
      folderPrefixes: [],
    })).toBe('overwrite');
  });

  it('reads per-refresh folders and no Parquet of its own as Create new', () => {
    expect(classifyFileVersioning({
      fileKeys: [],
      folderPrefixes: ['focus/data/billing_period=2026-10/20261001T030000Z-a1/', 'focus/data/billing_period=2026-10/20261002T030000Z-b2/'],
    })).toBe('create-new');
  });

  it('reads both as Overwrite: an export switched mid-month delivers in place from then on', () => {
    expect(classifyFileVersioning({
      fileKeys: ['focus/data/billing_period=2026-10/focus-00001.snappy.parquet'],
      folderPrefixes: ['focus/data/billing_period=2026-10/20261001T030000Z-a1/'],
    })).toBe('overwrite');
  });

  it.each([
    ['an empty folder', [], []],
    // a zero-byte folder marker or a stray non-Parquet object is no delivery
    ['only a folder marker', ['focus/data/billing_period=2026-10/'], []],
    ['only a stray object', ['focus/data/billing_period=2026-10/notes.txt'], []],
  ])('has no answer for %s', (_label, fileKeys, folderPrefixes) => {
    expect(classifyFileVersioning({ fileKeys, folderPrefixes })).toBe('unknown');
  });
});
