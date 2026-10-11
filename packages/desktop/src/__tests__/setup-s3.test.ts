import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUIRED_FOCUS_COLUMNS } from '../main/setup-manifest.js';
import { browseS3, listS3Buckets, testS3Connection } from '../main/setup-s3.js';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => {
  const S3ClientMock = vi.fn();
  S3ClientMock.prototype.send = mockSend;
  return {
    S3Client: S3ClientMock,
    ListObjectsV2Command: vi.fn(),
    ListBucketsCommand: vi.fn(),
    GetObjectCommand: vi.fn(),
  };
});

const body = (text: string): { transformToString: () => Promise<string> } => ({ transformToString: () => Promise.resolve(text) });

const exportRoot = { CommonPrefixes: [{ Prefix: 'focus/daily/data/' }, { Prefix: 'focus/daily/metadata/' }] };
// The File versioning probe: a delimited data/ listing, then one of its newest partition.
const dataListing = { CommonPrefixes: [{ Prefix: 'focus/daily/data/billing_period=2026-09/' }, { Prefix: 'focus/daily/data/billing_period=2026-10/' }] };
const overwritePartition = { Contents: [{ Key: 'focus/daily/data/billing_period=2026-10/daily-00001.snappy.parquet' }] };
const createNewPartition = { CommonPrefixes: [{ Prefix: 'focus/daily/data/billing_period=2026-10/20261002T030000Z-b2/' }] };
const metadataListing = {
  Contents: [
    { Key: 'focus/daily/metadata/daily-Manifest-FOCUS.json' },
    { Key: 'focus/daily/metadata/daily-Manifest.json' },
    { Key: 'focus/daily/metadata/notes.txt' },
  ],
};

// Every client starts in its profile's ~/.aws/config region, so each test
// gets a throwaway config: the developer's own profiles never leak in.
let configDir = '';
function useAwsConfig(contents: string): void {
  writeFileSync(join(configDir, 'config'), contents);
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued *Once values: drop them so a test that fails
  // before consuming its responses cannot feed them to the next one.
  mockSend.mockReset();
  configDir = mkdtempSync(join(tmpdir(), 'costgoblin-aws-'));
  useAwsConfig('');
  vi.stubEnv('AWS_CONFIG_FILE', join(configDir, 'config'));
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', join(configDir, 'credentials'));
  // 'default' reads the region of the profile AWS_PROFILE names ('' is unset).
  vi.stubEnv('AWS_PROFILE', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(configDir, { recursive: true, force: true });
});

describe('browseS3', () => {
  it('builds its client to follow region redirects, so a bucket outside the starting region browses', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    mockSend.mockResolvedValueOnce({ CommonPrefixes: [] });

    await browseS3({ profile: 'billing', bucket: 'b', prefix: '' });

    expect(S3Client).toHaveBeenCalledWith({ region: 'eu-central-1', followRegionRedirects: true, profile: 'billing' });
  });

  it('starts in the profile’s own region, so an export there needs no redirect', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    useAwsConfig('[profile billing]\nregion = eu-west-1\n');
    mockSend.mockResolvedValueOnce({ CommonPrefixes: [] });

    await browseS3({ profile: 'billing', bucket: 'b', prefix: '' });

    expect(S3Client).toHaveBeenCalledWith({ region: 'eu-west-1', followRegionRedirects: true, profile: 'billing' });
  });

  it('lists child folders relative to the prefix and classifies the export from its columns manifest', async () => {
    const { ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const partial = REQUIRED_FOCUS_COLUMNS.filter(c => c !== 'Tags');
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce(metadataListing)
      .mockResolvedValueOnce({ Body: body(JSON.stringify({ columns: partial.map(name => ({ name, type: 'STRING' })) })) })
      .mockResolvedValueOnce(dataListing)
      .mockResolvedValueOnce(overwritePartition);

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toEqual({ prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'daily', missingColumns: ['Tags'], fileVersioning: 'overwrite' });
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(1, { Bucket: 'b', Prefix: 'focus/daily/', Delimiter: '/', MaxKeys: 200 });
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(2, { Bucket: 'b', Prefix: 'focus/daily/metadata/', MaxKeys: 10 });
    // The FOCUS sidecar sorts first but has no `columns`; the real manifest is read.
    expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'focus/daily/metadata/daily-Manifest.json' });
    // File versioning is read off the newest month only.
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(3, { Bucket: 'b', Prefix: 'focus/daily/data/', Delimiter: '/', ContinuationToken: undefined });
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(4, { Bucket: 'b', Prefix: 'focus/daily/data/billing_period=2026-10/', Delimiter: '/', ContinuationToken: undefined });
  });

  it('reports an export whose newest month only holds per-refresh folders as Create new', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(dataListing)
      .mockResolvedValueOnce(createNewPartition);

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toMatchObject({ isBillingExport: true, fileVersioning: 'create-new' });
  });

  it('pages through data/ to find the newest month', async () => {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'focus/daily/data/billing_period=2026-09/' }], IsTruncated: true, NextContinuationToken: 'page-2' })
      .mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'focus/daily/data/billing_period=2026-10/' }] })
      .mockResolvedValueOnce(createNewPartition);

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result.fileVersioning).toBe('create-new');
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(4, { Bucket: 'b', Prefix: 'focus/daily/data/', Delimiter: '/', ContinuationToken: 'page-2' });
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(5, { Bucket: 'b', Prefix: 'focus/daily/data/billing_period=2026-10/', Delimiter: '/', ContinuationToken: undefined });
  });

  describe('a month holding both layouts (File versioning switched this month)', () => {
    const PARTITION = 'focus/daily/data/billing_period=2026-10/';
    const mixedLevel = {
      Contents: [{ Key: `${PARTITION}daily-00001.snappy.parquet`, LastModified: new Date('2026-10-10T03:00:00Z') }],
      CommonPrefixes: [{ Prefix: `${PARTITION}20261011T030000Z-b2/` }],
    };

    it('lists the whole month and goes by the delivery written last', async () => {
      const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      mockSend
        .mockResolvedValueOnce(exportRoot)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(dataListing)
        .mockResolvedValueOnce(mixedLevel)
        .mockResolvedValueOnce({ Contents: [
          ...mixedLevel.Contents,
          { Key: `${PARTITION}20261011T030000Z-b2/daily-00001.snappy.parquet`, LastModified: new Date('2026-10-11T03:00:00Z') },
        ] });

      const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

      // Switched from Overwrite to Create new: the in-place files are stale.
      expect(result.fileVersioning).toBe('create-new');
      expect(ListObjectsV2Command).toHaveBeenNthCalledWith(5, { Bucket: 'b', Prefix: PARTITION, ContinuationToken: undefined });
    });

    it('keeps the Overwrite verdict when the month is too large to list whole', async () => {
      mockSend
        .mockResolvedValueOnce(exportRoot)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(dataListing)
        .mockResolvedValueOnce(mixedLevel)
        .mockResolvedValue({ Contents: [], IsTruncated: true, NextContinuationToken: 'more' });

      const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

      expect(result.fileVersioning).toBe('overwrite');
      // 4 calls before the full listing, then its page cap.
      expect(mockSend).toHaveBeenCalledTimes(4 + 10);
    });
  });

  it('does not probe File versioning for a CUR 2.0 export, which is refused anyway', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce(metadataListing)
      .mockResolvedValueOnce({ Body: body(JSON.stringify({ columns: [{ name: 'line_item_usage_start_date' }] })) });

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toMatchObject({ detectedType: 'cur-legacy', fileVersioning: 'unknown' });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('does not probe File versioning for a Cost Optimization Hub export, which AWS never overwrites', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce(metadataListing)
      .mockResolvedValueOnce({ Body: body(JSON.stringify({ columns: [{ name: 'recommendation_id' }] })) });

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toMatchObject({ detectedType: 'cost-optimization', fileVersioning: 'unknown' });
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('leaves File versioning unknown for an export with no delivery yet', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result.fileVersioning).toBe('unknown');
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('keeps the type detection when the File versioning probe cannot list data/', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce(metadataListing)
      .mockResolvedValueOnce({ Body: body(JSON.stringify({ columns: [{ name: 'ChargePeriodStart' }] })) })
      .mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toMatchObject({ isBillingExport: true, detectedType: 'daily', fileVersioning: 'unknown' });
    expect(result.error).toBeUndefined();
  });

  it('skips manifest detection for a folder that is not an export root', async () => {
    mockSend.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'focus/' }, { Prefix: 'cur/' }, {}] });

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: '' });

    expect(result).toEqual({ prefixes: ['focus', 'cur'], isBillingExport: false, detectedType: 'unknown', missingColumns: [], fileVersioning: 'unknown' });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('treats an empty listing as no folders', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(browseS3({ profile: 'default', bucket: 'b', prefix: '' }))
      .resolves.toEqual({ prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [], fileVersioning: 'unknown' });
  });

  it.each([
    ['no metadata objects', [{}]],
    ['a manifest with no body', [{ Contents: [{ Key: 'focus/daily/metadata/daily-Manifest.json' }] }, {}]],
  ])('leaves the type unknown for an export root with %s', async (_label, responses) => {
    mockSend.mockResolvedValueOnce(exportRoot);
    for (const response of responses) mockSend.mockResolvedValueOnce(response);
    mockSend.mockResolvedValueOnce(dataListing).mockResolvedValueOnce(overwritePartition);

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toEqual({ prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'unknown', missingColumns: [], fileVersioning: 'overwrite' });
  });

  it('keeps the folders, and still probes File versioning, when the manifest cannot be read', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValueOnce(dataListing)
      .mockResolvedValueOnce(createNewPartition);

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toEqual({ prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'unknown', missingColumns: [], fileVersioning: 'create-new' });
  });

  it('surfaces a non-Error rejection as text', async () => {
    mockSend.mockRejectedValueOnce('socket hang up');

    await expect(browseS3({ profile: 'default', bucket: 'b', prefix: '' })).resolves.toMatchObject({ prefixes: [], error: 'socket hang up' });
  });

  it('surfaces a listing failure instead of an empty folder', async () => {
    mockSend.mockRejectedValueOnce(new Error('The bucket you are attempting to access must be addressed using the specified endpoint.'));

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: '' });

    expect(result).toEqual({
      prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [], fileVersioning: 'unknown',
      error: 'The bucket you are attempting to access must be addressed using the specified endpoint.',
    });
  });
});

describe('testS3Connection', () => {
  it('lists one key under the parsed bucket and prefix, on the default credential chain', async () => {
    const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    mockSend.mockResolvedValueOnce({});

    await expect(testS3Connection({ profile: 'default', bucket: 's3://b/focus/daily' })).resolves.toEqual({ ok: true });
    expect(S3Client).toHaveBeenCalledWith({ region: 'eu-central-1', followRegionRedirects: true });
    expect(ListObjectsV2Command).toHaveBeenCalledWith({ Bucket: 'b', Prefix: 'focus/daily', MaxKeys: 1 });
  });

  it('reports the failure', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access Denied'));

    await expect(testS3Connection({ profile: 'default', bucket: 'b' })).resolves.toEqual({ ok: false, error: 'Access Denied' });
  });

  it('reports a non-Error rejection as text', async () => {
    mockSend.mockRejectedValueOnce('socket hang up');

    await expect(testS3Connection({ profile: 'default', bucket: 'b' })).resolves.toEqual({ ok: false, error: 'socket hang up' });
  });
});

describe('listS3Buckets', () => {
  it('lists the account’s buckets by name, from the profile’s own region', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    useAwsConfig('[profile billing]\nregion = eu-west-1\n');
    mockSend.mockResolvedValueOnce({ Buckets: [{ Name: 'a' }, {}, { Name: 'b' }] });

    await expect(listS3Buckets('billing')).resolves.toEqual({ buckets: [{ name: 'a', region: '' }, { name: 'b', region: '' }] });
    expect(S3Client).toHaveBeenCalledWith({ region: 'eu-west-1', followRegionRedirects: true, profile: 'billing' });
  });

  it('treats a listing with no buckets as empty', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(listS3Buckets('default')).resolves.toEqual({ buckets: [] });
  });

  it.each([
    ['an Error', new Error('ExpiredToken'), 'ExpiredToken'],
    ['a non-Error', 'ExpiredToken', 'ExpiredToken'],
  ])('reports %s rejection with no buckets', async (_label, rejection, error) => {
    mockSend.mockRejectedValueOnce(rejection);

    await expect(listS3Buckets('billing')).resolves.toEqual({ buckets: [], error });
  });
});
