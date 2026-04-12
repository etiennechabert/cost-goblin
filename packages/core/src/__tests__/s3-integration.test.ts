import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createS3Handle } from '../sync/s3-client.js';
import type { S3Handle, S3EndpointOptions } from '../sync/s3-client.js';
import { getDataInventory } from '../sync/data-inventory.js';

const MINIO_ENDPOINT = process.env['MINIO_ENDPOINT'] ?? 'http://localhost:9000';
const BUCKET = 'costgoblin-test';
const PREFIX = 'cur/';
const CREDENTIALS = { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' };
const ENDPOINT_OPTIONS: S3EndpointOptions = {
  endpoint: MINIO_ENDPOINT,
  forcePathStyle: true,
  credentials: CREDENTIALS,
};

const FIXTURES_DIR = join(import.meta.dirname, '..', '__fixtures__', 'synthetic', 'aws', 'raw');

async function isMinioAvailable(): Promise<boolean> {
  try {
    const response = await fetch(`${MINIO_ENDPOINT}/minio/health/live`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function getS3Client(): Promise<import('@aws-sdk/client-s3').S3Client> {
  const { S3Client } = await import('@aws-sdk/client-s3');
  return new S3Client({
    region: 'us-east-1',
    endpoint: MINIO_ENDPOINT,
    forcePathStyle: true,
    credentials: CREDENTIALS,
  });
}

async function createBucket(client: import('@aws-sdk/client-s3').S3Client): Promise<void> {
  const { CreateBucketCommand, HeadBucketCommand } = await import('@aws-sdk/client-s3');
  try {
    await client.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
}

async function uploadFixture(client: import('@aws-sdk/client-s3').S3Client, localPath: string, key: string): Promise<void> {
  const { PutObjectCommand } = await import('@aws-sdk/client-s3');
  const body = await readFile(localPath);
  await client.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
}

async function deleteBucket(client: import('@aws-sdk/client-s3').S3Client): Promise<void> {
  const { ListObjectsV2Command, DeleteObjectCommand, DeleteBucketCommand } = await import('@aws-sdk/client-s3');
  const list = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
  for (const obj of list.Contents ?? []) {
    if (obj.Key !== undefined) {
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
    }
  }
  await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
}

const available = await isMinioAvailable();

describe.skipIf(!available)('S3 integration (MinIO)', () => {
  let rawClient: import('@aws-sdk/client-s3').S3Client;
  let s3: S3Handle;
  let tempDir: string;

  beforeAll(async () => {
    rawClient = await getS3Client();
    await createBucket(rawClient);

    await uploadFixture(
      rawClient,
      join(FIXTURES_DIR, 'daily-2026-01', 'data.parquet'),
      `${PREFIX}data/BILLING_PERIOD=2026-01/data.parquet`,
    );
    await uploadFixture(
      rawClient,
      join(FIXTURES_DIR, 'daily-2026-02', 'data.parquet'),
      `${PREFIX}data/BILLING_PERIOD=2026-02/data.parquet`,
    );

    s3 = await createS3Handle('default', 'us-east-1', ENDPOINT_OPTIONS);
    tempDir = await mkdtemp(join(tmpdir(), 'costgoblin-test-'));
  });

  afterAll(async () => {
    try { await deleteBucket(rawClient); } catch { /* best-effort */ }
    try { await rm(tempDir, { recursive: true }); } catch { /* best-effort */ }
  });

  it('listFiles returns parquet entries', async () => {
    const files = await s3.listFiles(BUCKET, `${PREFIX}data/`);
    expect(files.length).toBe(2);
    expect(files.every(f => f.key.endsWith('.parquet'))).toBe(true);
    expect(files.every(f => f.size > 0)).toBe(true);
    expect(files.every(f => f.contentHash.length > 0)).toBe(true);
  });

  it('listFiles filters by prefix', async () => {
    const files = await s3.listFiles(BUCKET, `${PREFIX}data/BILLING_PERIOD=2026-01/`);
    expect(files.length).toBe(1);
    expect(files[0]?.key).toContain('2026-01');
  });

  it('downloadFile retrieves correct content', async () => {
    const files = await s3.listFiles(BUCKET, `${PREFIX}data/BILLING_PERIOD=2026-01/`);
    const file = files[0];
    expect(file).toBeDefined();

    if (file === undefined) throw new Error('no file');
    const localPath = join(tempDir, 'downloaded.parquet');
    await s3.downloadFile(BUCKET, file.key, localPath);

    const downloaded = await readFile(localPath);
    const original = await readFile(join(FIXTURES_DIR, 'daily-2026-01', 'data.parquet'));
    expect(downloaded.length).toBe(original.length);
  });

  it('downloadFile supports abort signal', async () => {
    const files = await s3.listFiles(BUCKET, `${PREFIX}data/BILLING_PERIOD=2026-01/`);
    const file = files[0];
    expect(file).toBeDefined();

    if (file === undefined) throw new Error('no file');
    const controller = new AbortController();
    controller.abort();
    const localPath = join(tempDir, 'aborted.parquet');
    await expect(
      s3.downloadFile(BUCKET, file.key, localPath, { signal: controller.signal }),
    ).rejects.toThrow('Download cancelled');
  });

  it('getDataInventory builds inventory from remote files', async () => {
    const inventory = await getDataInventory(
      `s3://${BUCKET}/${PREFIX}data/`,
      'default',
      tempDir,
      'daily',
      s3,
    );

    expect(inventory.totalRemotePeriods).toBe(2);
    expect(inventory.totalLocalPeriods).toBe(0);
    expect(inventory.totalRemoteSize).toBeGreaterThan(0);

    const periods = inventory.periods.map(p => p.period).sort();
    expect(periods).toEqual(['2026-01', '2026-02']);
    expect(inventory.periods.every(p => p.localStatus === 'missing')).toBe(true);
  });
});
