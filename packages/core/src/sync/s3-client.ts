import { writeFile, mkdir } from 'node:fs/promises';
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
  } else if (profile !== 'default') {
    credentialConfig = { profile };
  } else {
    credentialConfig = {};
  }

  const client = new S3Client({
    region: region ?? 'eu-central-1',
    ...credentialConfig,
    ...(endpointOptions?.endpoint !== undefined ? { endpoint: endpointOptions.endpoint } : {}),
    ...(endpointOptions?.forcePathStyle !== undefined ? { forcePathStyle: endpointOptions.forcePathStyle } : {}),
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

      const chunks: Uint8Array[] = [];
      const body = response.Body;
      let totalBytes = 0;
      if (Symbol.asyncIterator in body) {
        const iterable = body as AsyncIterable<Uint8Array>;
        for await (const chunk of iterable) {
          if (options?.signal?.aborted) {
            throw new Error('Download cancelled');
          }
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
          options?.onBytes?.(totalBytes);
        }
      }

      await writeFile(localPath, Buffer.concat(chunks.map(c => Buffer.from(c))));
    },
  };
}

export interface SyncProgress {
  readonly phase: 'downloading' | 'repartitioning' | 'done';
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly message?: string | undefined;
}

export type ProgressCallback = (progress: SyncProgress) => void;

export { parseS3Path };
