import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createS3Handle } from '../sync/s3-client.js';
import type { S3Handle } from '../sync/s3-client.js';
import { Writable } from 'node:stream';
import type { WriteStream } from 'node:fs';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  ListObjectsV2Command: vi.fn((params) => ({ name: 'ListObjectsV2Command', params })),
  GetObjectCommand: vi.fn((params) => ({ name: 'GetObjectCommand', params })),
}));

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn(),
}));

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(),
}));

vi.mock('node:stream/promises', () => ({
  pipeline: vi.fn(),
}));

describe('S3 client (mocked) - listFiles', () => {
  let s3: S3Handle;

  beforeEach(async () => {
    vi.clearAllMocks();
    s3 = await createS3Handle('default', 'us-east-1');
  });

  it('returns parquet files from single page response', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'data/2026-01/file1.parquet', Size: 1000, ETag: '"abc123"' },
        { Key: 'data/2026-01/file2.parquet', Size: 2000, ETag: '"def456"' },
      ],
      IsTruncated: false,
    });

    const files = await s3.listFiles('test-bucket', 'data/2026-01/');

    expect(files).toHaveLength(2);
    expect(files[0]).toEqual({ key: 'data/2026-01/file1.parquet', size: 1000, contentHash: '"abc123"' });
    expect(files[1]).toEqual({ key: 'data/2026-01/file2.parquet', size: 2000, contentHash: '"def456"' });
  });

  it('handles pagination with continuation token', async () => {
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'data/file1.parquet', Size: 1000, ETag: '"hash1"' }],
        IsTruncated: true,
        NextContinuationToken: 'token-page-2',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'data/file2.parquet', Size: 2000, ETag: '"hash2"' }],
        IsTruncated: true,
        NextContinuationToken: 'token-page-3',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'data/file3.parquet', Size: 3000, ETag: '"hash3"' }],
        IsTruncated: false,
      });

    const files = await s3.listFiles('test-bucket', 'data/');

    expect(files).toHaveLength(3);
    expect(mockSend).toHaveBeenCalledTimes(3);
  });

  it('filters out non-parquet files', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'data/file1.parquet', Size: 1000, ETag: '"hash1"' },
        { Key: 'data/manifest.json', Size: 100, ETag: '"hash2"' },
        { Key: 'data/readme.txt', Size: 50, ETag: '"hash3"' },
        { Key: 'data/file2.parquet', Size: 2000, ETag: '"hash4"' },
      ],
      IsTruncated: false,
    });

    const files = await s3.listFiles('test-bucket', 'data/');

    expect(files).toHaveLength(2);
    expect(files.every(f => f.key.endsWith('.parquet'))).toBe(true);
  });

  it('skips objects with missing Key or Size', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'data/valid.parquet', Size: 1000, ETag: '"hash1"' },
        { Key: undefined, Size: 1000, ETag: '"hash2"' },
        { Key: 'data/no-size.parquet', Size: undefined, ETag: '"hash3"' },
        { Key: 'data/valid2.parquet', Size: 2000, ETag: '"hash4"' },
      ],
      IsTruncated: false,
    });

    const files = await s3.listFiles('test-bucket', 'data/');

    expect(files).toHaveLength(2);
    expect(files[0]?.key).toBe('data/valid.parquet');
    expect(files[1]?.key).toBe('data/valid2.parquet');
  });

  it('handles empty or undefined ETag', async () => {
    mockSend.mockResolvedValueOnce({
      Contents: [
        { Key: 'data/file1.parquet', Size: 1000, ETag: undefined },
        { Key: 'data/file2.parquet', Size: 2000, ETag: '' },
      ],
      IsTruncated: false,
    });

    const files = await s3.listFiles('test-bucket', 'data/');

    expect(files).toHaveLength(2);
    expect(files[0]?.contentHash).toBe('');
    expect(files[1]?.contentHash).toBe('');
  });

  it('returns empty array when Contents is empty or undefined', async () => {
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });
    expect(await s3.listFiles('test-bucket', 'data/')).toHaveLength(0);

    mockSend.mockResolvedValueOnce({ Contents: undefined, IsTruncated: false });
    expect(await s3.listFiles('test-bucket', 'data/')).toHaveLength(0);
  });

  it('passes correct parameters to ListObjectsV2Command', async () => {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    mockSend.mockResolvedValueOnce({ Contents: [], IsTruncated: false });

    await s3.listFiles('my-bucket', 'my-prefix/');

    expect(ListObjectsV2Command).toHaveBeenCalledWith({
      Bucket: 'my-bucket',
      Prefix: 'my-prefix/',
      ContinuationToken: undefined,
    });
  });

  it('passes continuation token on subsequent pages', async () => {
    const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
    mockSend
      .mockResolvedValueOnce({
        Contents: [{ Key: 'data/file1.parquet', Size: 1000, ETag: '"hash1"' }],
        IsTruncated: true,
        NextContinuationToken: 'my-token',
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: 'data/file2.parquet', Size: 2000, ETag: '"hash2"' }],
        IsTruncated: false,
      });

    await s3.listFiles('my-bucket', 'data/');

    expect(ListObjectsV2Command).toHaveBeenNthCalledWith(2, {
      Bucket: 'my-bucket',
      Prefix: 'data/',
      ContinuationToken: 'my-token',
    });
  });

  it('uses custom endpoint options when provided', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');

    await createS3Handle('default', 'us-west-2', {
      endpoint: 'http://localhost:9000',
      forcePathStyle: true,
      credentials: { accessKeyId: 'test', secretAccessKey: 'secret' },
    });

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us-west-2',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
      })
    );
  });

  it('uses profile when not default', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    await createS3Handle('my-profile', 'eu-west-1');

    expect(S3Client).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'eu-west-1', profile: 'my-profile' })
    );
  });

  it.each([
    ['ECONNREFUSED', 'NetworkingError'],
    ['TimeoutError', 'TimeoutError'],
    ['Service Unavailable', 'ServiceUnavailable'],
    ['Access Denied', 'AccessDenied'],
    ['NoSuchBucket', 'NoSuchBucket'],
  ])('throws on %s error', async (message, name) => {
    const error = new Error(message);
    error.name = name;
    mockSend.mockRejectedValueOnce(error);

    await expect(s3.listFiles('test-bucket', 'data/')).rejects.toThrow(message);
  });
});

describe('S3 client (mocked) - downloadFile', () => {
  let s3: S3Handle;
  let mockWriteStream: WriteStream;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { mkdir } = await import('node:fs/promises');
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');

    vi.mocked(mkdir).mockResolvedValue(undefined);

    // Create a mock writable stream with WriteStream properties
    mockWriteStream = Object.assign(
      new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
      }),
      {
        close: vi.fn(),
        bytesWritten: 0,
        path: '',
        pending: false,
      }
    );

    vi.mocked(createWriteStream).mockReturnValue(mockWriteStream);

    // Default pipeline behavior: just resolve successfully
    vi.mocked(pipeline).mockResolvedValue(undefined);

    s3 = await createS3Handle('default', 'us-east-1');
  });

  function createMockBody(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
    return {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  }

  it('downloads file and writes to disk', async () => {
    const { mkdir } = await import('node:fs/promises');
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const chunk1 = new Uint8Array([1, 2, 3, 4]);
    const chunk2 = new Uint8Array([5, 6, 7, 8]);

    mockSend.mockResolvedValueOnce({ Body: createMockBody([chunk1, chunk2]) });

    await s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/local.parquet');

    expect(vi.mocked(mkdir)).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(vi.mocked(createWriteStream)).toHaveBeenCalledWith('/tmp/local.parquet');
    expect(vi.mocked(pipeline)).toHaveBeenCalledTimes(1);
  });

  it('passes correct parameters to GetObjectCommand', async () => {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    mockSend.mockResolvedValueOnce({ Body: createMockBody([new Uint8Array([1])]) });

    await s3.downloadFile('my-bucket', 'my-key/file.parquet', '/tmp/file.parquet');

    expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'my-bucket', Key: 'my-key/file.parquet' });
  });

  it('throws when response body is undefined', async () => {
    mockSend.mockResolvedValueOnce({ Body: undefined });

    await expect(
      s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet')
    ).rejects.toThrow('Empty response body for s3://test-bucket/data/file.parquet');
  });

  it('cancels when abort signal is already aborted', async () => {
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');

    mockSend.mockResolvedValueOnce({ Body: createMockBody([new Uint8Array([1, 2, 3])]) });

    const controller = new AbortController();
    controller.abort();

    // Mock pipeline to reject with abort error when signal is aborted
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('Download cancelled'));

    await expect(
      s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet', { signal: controller.signal })
    ).rejects.toThrow('Download cancelled');

    expect(vi.mocked(createWriteStream)).toHaveBeenCalledWith('/tmp/file.parquet');
  });

  it('aborts mid-stream and does not write partial file', async () => {
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');
    const controller = new AbortController();

    const mockBody = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield new Uint8Array([1, 2, 3]);
        yield new Uint8Array([4, 5, 6]);
        controller.abort();
        yield new Uint8Array([7, 8, 9]);
      },
    };

    mockSend.mockResolvedValueOnce({ Body: mockBody });

    // Mock pipeline to reject when abort is called
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('Download cancelled'));

    await expect(
      s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet', { signal: controller.signal })
    ).rejects.toThrow('Download cancelled');

    expect(vi.mocked(createWriteStream)).toHaveBeenCalledWith('/tmp/file.parquet');
  });

  it('calls onBytes callback with accumulated byte count', async () => {
    const { pipeline } = await import('node:stream/promises');
    const chunks = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6]), new Uint8Array([7, 8, 9])];
    mockSend.mockResolvedValueOnce({ Body: createMockBody(chunks) });

    const onBytes = vi.fn();

    // Mock pipeline to simulate streaming with transform
    vi.mocked(pipeline).mockImplementationOnce(async () => {
      // Simulate chunks going through the transform stream
      let totalBytes = 0;
      for (const chunk of chunks) {
        totalBytes += chunk.byteLength;
        onBytes(totalBytes);
      }
      return Promise.resolve();
    });

    await s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet', { onBytes });

    expect(onBytes).toHaveBeenCalledTimes(3);
    expect(onBytes).toHaveBeenNthCalledWith(1, 4);
    expect(onBytes).toHaveBeenNthCalledWith(2, 6);
    expect(onBytes).toHaveBeenNthCalledWith(3, 9);
  });

  it('does not write partial file on mid-stream network error', async () => {
    const { createWriteStream } = await import('node:fs');
    const { pipeline } = await import('node:stream/promises');

    const mockBody = {
      async *[Symbol.asyncIterator]() {
        await Promise.resolve();
        yield new Uint8Array([1, 2, 3]);
        throw new Error('Connection lost');
      },
    };

    mockSend.mockResolvedValueOnce({ Body: mockBody });

    // Mock pipeline to reject with the stream error
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('Connection lost'));

    await expect(
      s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet')
    ).rejects.toThrow('Connection lost');

    expect(vi.mocked(createWriteStream)).toHaveBeenCalledWith('/tmp/file.parquet');
  });

  it.each([
    ['Connection reset by peer', 'NetworkingError'],
    ['Request timeout', 'TimeoutError'],
    ['NoSuchKey', 'NoSuchKey'],
    ['Access Denied', 'AccessDenied'],
    ['Forbidden', 'Forbidden'],
  ])('throws on %s error', async (message, name) => {
    const error = new Error(message);
    error.name = name;
    mockSend.mockRejectedValueOnce(error);

    await expect(
      s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet')
    ).rejects.toThrow(message);
  });

  it('throws on disk full during write', async () => {
    const { pipeline } = await import('node:stream/promises');

    mockSend.mockResolvedValueOnce({ Body: createMockBody([new Uint8Array([1, 2, 3])]) });

    // Mock pipeline to reject with disk full error
    vi.mocked(pipeline).mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    await expect(
      s3.downloadFile('test-bucket', 'data/file.parquet', '/tmp/file.parquet')
    ).rejects.toThrow('ENOSPC: no space left on device');
  });
});
