import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createGcsHandle } from '../sync/gcs-client.js';

/** The two halves of the GCS handle the bucket-name suite leaves alone: how
 *  object metadata becomes a manifest entry (the SDK types `size` as
 *  `string | number` and may omit `crc32c`), and the byte-progress download
 *  path. `createGcsStorage` is the one place a client is built, so faking it
 *  keeps every SDK and credential out of the test. */

interface FakeObject {
  readonly name: string;
  readonly metadata: { readonly crc32c?: string; readonly size?: string | number };
}

interface FakeStorage {
  bucket(): {
    getFiles(): Promise<(readonly FakeObject[])[]>;
    file(): { createReadStream(): Readable };
  };
}

const { listing, chunks, createGcsStorage } = vi.hoisted(() => {
  const listing: { objects: readonly FakeObject[] } = { objects: [] };
  const chunks: { body: readonly Buffer[] } = { body: [] };
  return {
    listing,
    chunks,
    // One bucket answers for every name and every key: the guard on the name
    // is the bucket-name suite's subject, not this one's.
    createGcsStorage: vi.fn<(options: Record<string, unknown>) => Promise<FakeStorage>>(() => Promise.resolve({
      bucket: () => ({
        getFiles: () => Promise.resolve([listing.objects]),
        file: () => ({ createReadStream: (): Readable => Readable.from(chunks.body) }),
      }),
    })),
  };
});

vi.mock('../sync/gcs-storage.js', () => ({ createGcsStorage }));

describe('createGcsHandle', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    listing.objects = [];
    chunks.body = [];
    dir = await mkdtemp(join(tmpdir(), 'gcs-handle-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('turns every size shape the SDK can hand back into a finite byte count', async () => {
    listing.objects = [
      { name: 'p/billing_period=2026-01/numeric.parquet', metadata: { crc32c: 'c1', size: 1234 } },
      { name: 'p/billing_period=2026-01/textual.parquet', metadata: { crc32c: 'c2', size: '5678' } },
      // A bad size must not poison the inventory's byte totals with NaN.
      { name: 'p/billing_period=2026-01/nan.parquet', metadata: { crc32c: 'c3', size: Number.NaN } },
      { name: 'p/billing_period=2026-01/garbled.parquet', metadata: { crc32c: 'c4', size: 'unknown' } },
      // Neither hash nor size: still listed, as an unhashed empty object.
      { name: 'p/billing_period=2026-01/bare.parquet', metadata: {} },
      { name: 'p/billing_period=2026-01/_manifest.json', metadata: { crc32c: 'c6', size: '10' } },
    ];
    const handle = await createGcsHandle({ keyFile: '/keys/reader.json' });

    const entries = await handle.listFiles('billing-export', 'p/');

    expect(createGcsStorage).toHaveBeenCalledWith({ keyFile: '/keys/reader.json' });
    expect(entries).toEqual([
      { key: 'p/billing_period=2026-01/numeric.parquet', contentHash: 'c1', size: 1234 },
      { key: 'p/billing_period=2026-01/textual.parquet', contentHash: 'c2', size: 5678 },
      { key: 'p/billing_period=2026-01/nan.parquet', contentHash: 'c3', size: 0 },
      { key: 'p/billing_period=2026-01/garbled.parquet', contentHash: 'c4', size: 0 },
      { key: 'p/billing_period=2026-01/bare.parquet', contentHash: '', size: 0 },
    ]);
  });

  it('reports the running byte count of a download as each chunk lands', async () => {
    chunks.body = [Buffer.from('PAR1'), Buffer.from('-rows-'), Buffer.from('PAR1')];
    const seen: number[] = [];
    const handle = await createGcsHandle();
    const localPath = join(dir, 'nested', 'probe.parquet');

    await handle.downloadFile('billing-export', 'p/billing_period=2026-01/shard-0.parquet', localPath, {
      onBytes: (bytes) => { seen.push(bytes); },
    });

    expect(seen).toEqual([4, 10, 14]);
    expect(await readFile(localPath, 'utf-8')).toBe('PAR1-rows-PAR1');
  });

  it('downloads without progress when only a signal is given', async () => {
    chunks.body = [Buffer.from('PAR1'), Buffer.from('PAR1')];
    const handle = await createGcsHandle();
    const localPath = join(dir, 'signal-only.parquet');

    await handle.downloadFile('billing-export', 'k.parquet', localPath, { signal: new AbortController().signal });

    expect(await readFile(localPath, 'utf-8')).toBe('PAR1PAR1');
  });

  it('abandons a cancelled download with an abort, whether or not progress is reported', async () => {
    chunks.body = [Buffer.from('PAR1')];
    const controller = new AbortController();
    controller.abort();
    const onBytes = vi.fn();
    const handle = await createGcsHandle();

    await expect(handle.downloadFile('billing-export', 'k.parquet', join(dir, 'a.parquet'), { signal: controller.signal, onBytes }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await expect(handle.downloadFile('billing-export', 'k.parquet', join(dir, 'b.parquet'), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(onBytes).not.toHaveBeenCalled();
  });
});
