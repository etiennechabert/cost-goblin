import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { dirname } from 'node:path';
import type { ManifestFileEntry } from './manifest.js';

export interface S3SyncOptions {
  readonly bucket: string;
  readonly prefix: string;
  readonly profile: string;
  readonly region?: string | undefined;
}

export interface S3EndpointOptions {
  readonly endpoint?: string | undefined;
  readonly forcePathStyle?: boolean | undefined;
  readonly credentials?: { readonly accessKeyId: string; readonly secretAccessKey: string } | undefined;
}

function parseS3Path(s3Path: string): { bucket: string; prefix: string } {
  const stripped = s3Path.replace(/^s3:\/\//, '');
  const slashIdx = stripped.indexOf('/');
  if (slashIdx === -1) {
    return { bucket: stripped, prefix: '' };
  }
  return {
    bucket: stripped.slice(0, slashIdx),
    prefix: stripped.slice(slashIdx + 1),
  };
}

async function getS3Module(): Promise<typeof import('@aws-sdk/client-s3')> {
  return import('@aws-sdk/client-s3');
}

export interface DownloadOptions {
  onBytes?: ((bytesReceived: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

export interface S3Handle {
  listFiles(bucket: string, prefix: string): Promise<ManifestFileEntry[]>;
  downloadFile(bucket: string, key: string, localPath: string, options?: DownloadOptions): Promise<void>;
}

export async function createS3Handle(profile: string, region?: string, endpointOptions?: S3EndpointOptions): Promise<S3Handle> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await getS3Module();

  let credentialConfig: { credentials: { readonly accessKeyId: string; readonly secretAccessKey: string } } | { profile: string } | Record<string, never>;
  if (endpointOptions?.credentials !== undefined) {
    credentialConfig = { credentials: endpointOptions.credentials };
  } else if (profile === 'default') {
    credentialConfig = {};
  } else {
    credentialConfig = { profile };
  }

  const client = new S3Client({
    region: region ?? 'eu-central-1',
    ...credentialConfig,
    ...(endpointOptions?.endpoint === undefined ? {} : { endpoint: endpointOptions.endpoint }),
    ...(endpointOptions?.forcePathStyle === undefined ? {} : { forcePathStyle: endpointOptions.forcePathStyle }),
  });

  return {
    async listFiles(bucket: string, prefix: string): Promise<ManifestFileEntry[]> {
      const entries: ManifestFileEntry[] = [];
      let continuationToken: string | undefined;

      do {
        const command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        const response = await client.send(command);

        for (const obj of response.Contents ?? []) {
          if (obj.Key === undefined || obj.Size === undefined) continue;
          if (obj.Key.endsWith('.parquet')) {
            entries.push({ key: obj.Key, contentHash: obj.ETag ?? '', size: obj.Size });
          }
        }

        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken !== undefined);

      return entries;
    },

    async downloadFile(bucket: string, key: string, localPath: string, options?: DownloadOptions): Promise<void> {
      await mkdir(dirname(localPath), { recursive: true });

      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await client.send(command);

      if (response.Body === undefined) {
        throw new Error(`Empty response body for s3://${bucket}/${key}`);
      }

      const body = response.Body;
      if (!(Symbol.asyncIterator in body)) {
        throw new Error(`S3 response body is not iterable for s3://${bucket}/${key}`);
      }

      const sourceStream = Readable.from(body as AsyncIterable<Uint8Array>);
      const writeStream = createWriteStream(localPath);

      if (options?.onBytes === undefined) {
        await pipeline(sourceStream, writeStream, {
          signal: options?.signal,
        });
      } else {
        const onBytes = options.onBytes;
        let totalBytes = 0;
        const progressStream = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            totalBytes += chunk.byteLength;
            onBytes(totalBytes);
            callback(null, chunk);
          },
        });

        await pipeline(sourceStream, progressStream, writeStream, {
          signal: options.signal,
        });
      }
    },
  };
}

export interface SyncProgress {
  readonly phase: 'downloading' | 'repartitioning' | 'done';
  readonly filesTotal: number;
  readonly filesDone: number;
  // bytesTotal/bytesDone come from `aws s3 sync` "Completed X MiB/Y MiB"
  // lines. Files-done only ticks when a file fully finishes, so on a small
  // number of large files the file count stays at 0 long enough for the
  // progress bar to look frozen. Byte counts make mid-flight progress
  // visible. Both fields are absent until the first "Completed" line lands.
  readonly bytesTotal?: number | undefined;
  readonly bytesDone?: number | undefined;
  readonly message?: string | undefined;
}

export type ProgressCallback = (progress: SyncProgress) => void;

export { parseS3Path };
