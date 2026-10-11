import { describe, expect, it } from 'vitest';
import { newestDeliveryVersioning, newestPartitionFolder, partitionDeliveries } from '../main/setup-file-versioning.js';

const PARTITION = 'focus/data/billing_period=2026-10/';
const inPlace = (day: number): { key: string; lastModified: Date } =>
  ({ key: `${PARTITION}focus-00001.snappy.parquet`, lastModified: new Date(Date.UTC(2026, 9, day)) });
const perRefresh = (day: number): { key: string; lastModified: Date } =>
  ({ key: `${PARTITION}2026100${String(day)}T030000Z-r${String(day)}/focus-00001.snappy.parquet`, lastModified: new Date(Date.UTC(2026, 9, day)) });

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

describe('partitionDeliveries', () => {
  it('sees Parquet in the folder itself as in place', () => {
    expect(partitionDeliveries({ objects: [inPlace(2)], folderPrefixes: [] })).toBe('in-place');
  });

  it('sees subfolders and no Parquet of its own as per refresh', () => {
    expect(partitionDeliveries({ objects: [], folderPrefixes: [`${PARTITION}20261001T030000Z-a1/`] })).toBe('per-refresh');
  });

  it('sees both: an export whose setting changed this month', () => {
    expect(partitionDeliveries({ objects: [inPlace(2)], folderPrefixes: [`${PARTITION}20261001T030000Z-a1/`] })).toBe('both');
  });

  it.each([
    ['an empty folder', []],
    // a zero-byte folder marker or a stray non-Parquet object is no delivery
    ['only a folder marker', [{ key: PARTITION, lastModified: undefined }]],
    ['only a stray object', [{ key: `${PARTITION}notes.txt`, lastModified: undefined }]],
  ])('sees nothing in %s', (_label, objects) => {
    expect(partitionDeliveries({ objects, folderPrefixes: [] })).toBe('none');
  });
});

describe('newestDeliveryVersioning', () => {
  it('reads an export switched to Overwrite, once it has delivered in place, as Overwrite', () => {
    expect(newestDeliveryVersioning(PARTITION, [perRefresh(1), perRefresh(2), inPlace(3)])).toBe('overwrite');
  });

  it('reads an export switched from Overwrite to Create new as Create new, despite its stale in-place files', () => {
    expect(newestDeliveryVersioning(PARTITION, [inPlace(10), perRefresh(11)])).toBe('create-new');
  });

  it('favours Overwrite on a tie or a missing date', () => {
    expect(newestDeliveryVersioning(PARTITION, [inPlace(5), perRefresh(5)])).toBe('overwrite');
    expect(newestDeliveryVersioning(PARTITION, [
      { key: `${PARTITION}focus-00001.snappy.parquet`, lastModified: undefined },
      { key: `${PARTITION}r1/focus-00001.snappy.parquet`, lastModified: undefined },
    ])).toBe('overwrite');
  });

  it('ignores objects that are not Parquet or sit outside the partition', () => {
    expect(newestDeliveryVersioning(PARTITION, [
      inPlace(1),
      { key: `${PARTITION}r9/notes.txt`, lastModified: new Date(Date.UTC(2026, 9, 9)) },
      { key: 'focus/data/billing_period=2026-11/r9/x.parquet', lastModified: new Date(Date.UTC(2026, 10, 9)) },
    ])).toBe('overwrite');
    expect(newestDeliveryVersioning(PARTITION, [])).toBe('unknown');
  });
});
