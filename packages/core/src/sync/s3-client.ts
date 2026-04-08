import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ManifestFileEntry } from './manifest.js';

export interface S3SyncOptions {
  readonly bucket: string;
  readonly prefix: string;
  readonly profile: string;
  readonly region?: string | undefined;
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

export async function createS3Handle(profile: string, region?: string): Promise<S3Handle> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await getS3Module();

  const client = new S3Client({
    region: region ?? 'eu-central-1',
    ...(profile !== 'default' ? { profile } : {}),
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

        if (response.Contents !== undefined) {
          for (const obj of response.Contents) {
            if (obj.Key === undefined || obj.Size === undefined) continue;
            if (!obj.Key.endsWith('.parquet')) continue;
            entries.push({
              key: obj.Key,
              contentHash: obj.ETag ?? '',
              size: obj.Size,
            });
          }
        }

        continuationToken = response.IsTruncated === true ? response.NextContinuationToken : undefined;
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

      const chunks: Buffer[] = [];
      const body = response.Body;
      let totalBytes = 0;
      if (typeof (body as NodeJS.ReadableStream)[Symbol.asyncIterator] === 'function') {
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          if (options?.signal?.aborted) {
            throw new Error('Download cancelled');
          }
          const buf = Buffer.from(chunk);
          chunks.push(buf);
          totalBytes += buf.length;
          options?.onBytes?.(totalBytes);
        }
      }

      await writeFile(localPath, Buffer.concat(chunks));
    },
  };
}

export interface FileValidationInfo {
  readonly file: string;
  readonly valid: boolean;
  readonly detectedType: string;
  readonly message?: string | undefined;
}

export interface SyncProgress {
  readonly phase: 'listing' | 'downloading' | 'validating' | 'repartitioning' | 'done';
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly bytesTotal: number;
  readonly bytesDone: number;
  readonly currentFile?: string | undefined;
  readonly bytesPerSecond?: number | undefined;
  readonly validationResults?: readonly FileValidationInfo[] | undefined;
}

export type ProgressCallback = (progress: SyncProgress) => void;

export { parseS3Path };
