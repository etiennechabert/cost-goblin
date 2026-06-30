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

/** Whether an error indicates missing or expired credentials (expired SSO
 *  token, no resolvable profile) rather than a genuine S3/network failure.
 *  Covers both AWS SDK errors (the inventory listing) and the `aws s3 sync`
 *  CLI's stderr signatures (the download path), so credential expiry is
 *  surfaced consistently across both. Shared by the desktop sync handlers and
 *  the auto-sync scheduler. */
export function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === 'CredentialsProviderError' || name === 'TokenProviderError') return true;
  const msg = err.message;
  return (
    // AWS SDK credential-resolution failures.
    msg.includes('Token is expired') ||
    msg.includes('SSO session') ||
    msg.includes('credentials') ||
    // `aws s3 sync` CLI credential/SSO failures arrive as stderr text rather
    // than SDK error names, so the CLI download path classifies them too.
    msg.includes('Error loading SSO Token') ||
    msg.includes('Token has expired and refresh failed') ||
    msg.includes('ExpiredToken') ||
    msg.includes('InvalidGrantException') ||
    msg.includes('Unable to locate credentials') ||
    msg.includes('aws sso login')
  );
}

/** An `aws s3 sync` download that failed by exhausting retries or losing the
 *  connection, with no explicit credential/SSO text in stderr. For an
 *  SSO-backed bucket this is almost always an expired session, but it can be a
 *  network/VPN drop — so callers surface a "session may have expired, or check
 *  your connection" hint with the sign-in action, distinct from a definite
 *  `isCredentialError`. Scoped to the CLI failure (`aws s3 sync failed`) so it
 *  never misclassifies SDK or other errors. */
export function isS3SyncDownloadFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg.includes('aws s3 sync failed')) return false;
  return (
    msg.includes('Max Retries Exceeded') ||
    msg.includes('download failed') ||
    msg.includes('Could not connect to the endpoint')
  );
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
