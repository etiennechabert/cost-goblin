import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGcsHandle } from '../sync/gcs-client.js';

/** The SDK is replaced wholesale: the code under test calls `new Storage()`,
 *  so the export must be constructible (a class, not an arrow `vi.fn`), and
 *  `bucket` is the one call the name check has to guard. */
interface FakeObject { name: string; metadata: { crc32c: string; size: string } }
interface FakeBucket {
  getFiles: () => Promise<FakeObject[][]>;
  file: () => { createReadStream: () => Readable };
}

const { mockBucket } = vi.hoisted(() => ({
  mockBucket: vi.fn<(name: string) => FakeBucket>(() => ({
    getFiles: () => Promise.resolve([[
      { name: 'focus/daily/billing_period=2026-01/shard-0.parquet', metadata: { crc32c: 'crc', size: '5' } },
      { name: 'focus/daily/_SUCCESS', metadata: { crc32c: 'x', size: '0' } },
    ]]),
    file: () => ({
      createReadStream: (): Readable => Readable.from([Buffer.from('bytes')]),
    }),
  })),
}));

vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(name: string): FakeBucket {
      return mockBucket(name);
    }
  },
}));

const INVALID = [String.raw`evil-bkt\o#"&calc&"`, 'bkt?x=1', 'bkt%2Fo', 'Bkt', ''];

describe('createGcsHandle bucket-name guard', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await mkdtemp(join(tmpdir(), 'gcs-client-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects listFiles for an invalid bucket name without calling the SDK', async () => {
    const handle = await createGcsHandle();
    for (const bad of INVALID) {
      await expect(handle.listFiles(bad, 'focus/daily/'), bad).rejects.toThrow(/Invalid GCS bucket name/);
    }
    expect(mockBucket).not.toHaveBeenCalled();
  });

  it('rejects downloadFile for an invalid bucket name before creating any directory', async () => {
    const handle = await createGcsHandle();
    for (const bad of INVALID) {
      const localPath = join(dir, 'nested', 'out.parquet');
      await expect(handle.downloadFile(bad, 'k.parquet', localPath), bad).rejects.toThrow(/Invalid GCS bucket name/);
    }
    expect(mockBucket).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([]);
  });

  it('lists a valid bucket through the SDK, keeping only Parquet objects', async () => {
    const handle = await createGcsHandle();
    const entries = await handle.listFiles('billing-export', 'focus/daily/');
    expect(mockBucket).toHaveBeenCalledWith('billing-export');
    expect(entries).toEqual([{ key: 'focus/daily/billing_period=2026-01/shard-0.parquet', contentHash: 'crc', size: 5 }]);
  });

  it('downloads from a valid bucket through the SDK', async () => {
    const handle = await createGcsHandle();
    const localPath = join(dir, 'nested', 'out.parquet');
    await handle.downloadFile('billing-export', 'k.parquet', localPath);
    expect(mockBucket).toHaveBeenCalledWith('billing-export');
    expect(await readdir(join(dir, 'nested'))).toEqual(['out.parquet']);
  });
});
