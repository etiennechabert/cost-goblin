import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createS3Handle } from '../sync/s3-client.js';

/** The S3 download path end to end over real streams and a real tmp dir —
 *  `s3-client-mock.test.ts` replaces `pipeline` itself, so the progress
 *  transform never runs there. Only the SDK client is faked: `send` answers
 *  every GetObject with `response.body`, so no request leaves the process. A
 *  region is passed explicitly, so no ~/.aws file is read either. */

const { response, sent } = vi.hoisted(() => {
  const next: { body: unknown } = { body: undefined };
  const commands: unknown[] = [];
  return { response: next, sent: commands };
});

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: class {
    send(command: unknown): Promise<unknown> {
      sent.push(command);
      return Promise.resolve({ Body: response.body });
    }
  },
  ListObjectsV2Command: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
  GetObjectCommand: class {
    readonly input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  },
}));

function bodyOf(chunks: readonly Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
      }
    },
  };
}

describe('createS3Handle downloadFile', () => {
  let dir: string;

  beforeEach(async () => {
    sent.length = 0;
    response.body = undefined;
    dir = await mkdtemp(join(tmpdir(), 's3-download-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the running byte count as each chunk is written', async () => {
    response.body = bodyOf([Uint8Array.from([80, 65, 82, 49]), Uint8Array.from([0, 0]), Uint8Array.from([80, 65, 82])]);
    const seen: number[] = [];
    const s3 = await createS3Handle('billing-reader', 'eu-west-1');
    const localPath = join(dir, 'nested', 'probe.parquet');

    await s3.downloadFile('billing', 'cur/data/billing_period=2026-01/part-0.parquet', localPath, {
      onBytes: (bytes) => { seen.push(bytes); },
    });

    expect(seen).toEqual([4, 6, 9]);
    expect([...await readFile(localPath)]).toEqual([80, 65, 82, 49, 0, 0, 80, 65, 82]);
    expect(sent).toEqual([{ input: { Bucket: 'billing', Key: 'cur/data/billing_period=2026-01/part-0.parquet' } }]);
  });

  it('refuses a response body it cannot stream, before creating the local file', async () => {
    // A body with no async iterator (a web Blob, say) cannot be piped to disk.
    response.body = { transformToByteArray: () => Promise.resolve(new Uint8Array(0)) };
    const s3 = await createS3Handle('billing-reader', 'eu-west-1');
    const localPath = join(dir, 'probe.parquet');

    await expect(s3.downloadFile('billing', 'cur/data/part-0.parquet', localPath))
      .rejects.toThrow('S3 response body is not iterable for s3://billing/cur/data/part-0.parquet');
    await expect(stat(localPath)).rejects.toThrow(/ENOENT/);
  });
});
