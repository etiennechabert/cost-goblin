import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const metadataListing = {
  Contents: [
    { Key: 'focus/daily/metadata/daily-Manifest-FOCUS.json' },
    { Key: 'focus/daily/metadata/daily-Manifest.json' },
    { Key: 'focus/daily/metadata/notes.txt' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued *Once values: drop them so a test that fails
  // before consuming its responses cannot feed them to the next one.
  mockSend.mockReset();
});

describe('browseS3', () => {
  it('builds its client to follow region redirects, so a bucket outside the starting region browses', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    mockSend.mockResolvedValueOnce({ CommonPrefixes: [] });

    await browseS3({ profile: 'billing', bucket: 'b', prefix: '' });

    expect(S3Client).toHaveBeenCalledWith({ region: 'eu-central-1', followRegionRedirects: true, profile: 'billing' });
  });

  it('lists child folders relative to the prefix and classifies the export from its columns manifest', async () => {
    const { ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
    const partial = REQUIRED_FOCUS_COLUMNS.filter(c => c !== 'Tags');
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockResolvedValueOnce(metadataListing)
      .mockResolvedValueOnce({ Body: body(JSON.stringify({ columns: partial.map(name => ({ name, type: 'STRING' })) })) });

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toEqual({ prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'daily', missingColumns: ['Tags'] });
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(1, { Bucket: 'b', Prefix: 'focus/daily/', Delimiter: '/', MaxKeys: 200 });
    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(2, { Bucket: 'b', Prefix: 'focus/daily/metadata/', MaxKeys: 10 });
    // The FOCUS sidecar sorts first but has no `columns`; the real manifest is read.
    expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'b', Key: 'focus/daily/metadata/daily-Manifest.json' });
  });

  it('skips manifest detection for a folder that is not an export root', async () => {
    mockSend.mockResolvedValueOnce({ CommonPrefixes: [{ Prefix: 'focus/' }, { Prefix: 'cur/' }, {}] });

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: '' });

    expect(result).toEqual({ prefixes: ['focus', 'cur'], isBillingExport: false, detectedType: 'unknown', missingColumns: [] });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('treats an empty listing as no folders', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(browseS3({ profile: 'default', bucket: 'b', prefix: '' }))
      .resolves.toEqual({ prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [] });
  });

  it.each([
    ['no metadata objects', [{}]],
    ['a manifest with no body', [{ Contents: [{ Key: 'focus/daily/metadata/daily-Manifest.json' }] }, {}]],
  ])('leaves the type unknown for an export root with %s', async (_label, responses) => {
    mockSend.mockResolvedValueOnce(exportRoot);
    for (const response of responses) mockSend.mockResolvedValueOnce(response);

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toEqual({ prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'unknown', missingColumns: [] });
  });

  it('keeps the folders when the manifest cannot be read', async () => {
    mockSend
      .mockResolvedValueOnce(exportRoot)
      .mockRejectedValueOnce(new Error('AccessDenied'));

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: 'focus/daily/' });

    expect(result).toEqual({ prefixes: ['data', 'metadata'], isBillingExport: true, detectedType: 'unknown', missingColumns: [] });
  });

  it('surfaces a non-Error rejection as text', async () => {
    mockSend.mockRejectedValueOnce('socket hang up');

    await expect(browseS3({ profile: 'default', bucket: 'b', prefix: '' })).resolves.toMatchObject({ prefixes: [], error: 'socket hang up' });
  });

  it('surfaces a listing failure instead of an empty folder', async () => {
    mockSend.mockRejectedValueOnce(new Error('The bucket you are attempting to access must be addressed using the specified endpoint.'));

    const result = await browseS3({ profile: 'default', bucket: 'b', prefix: '' });

    expect(result).toEqual({
      prefixes: [], isBillingExport: false, detectedType: 'unknown', missingColumns: [],
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
  it('lists the account’s buckets by name', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    mockSend.mockResolvedValueOnce({ Buckets: [{ Name: 'a' }, {}, { Name: 'b' }] });

    await expect(listS3Buckets('billing')).resolves.toEqual({ buckets: [{ name: 'a', region: '' }, { name: 'b', region: '' }] });
    expect(S3Client).toHaveBeenCalledWith({ region: 'us-east-1', followRegionRedirects: true, profile: 'billing' });
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
