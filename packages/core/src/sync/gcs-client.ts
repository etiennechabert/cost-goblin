import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname } from 'node:path';
import type { ManifestFileEntry } from './manifest.js';
import type { DownloadOptions, ObjectStoreHandle } from './object-store.js';
import { assertValidGcsBucketName, splitGcsLocation } from './gcs-bucket-name.js';
import { createGcsStorage } from './gcs-storage.js';
import type { GcsStorageOptions } from './gcs-storage.js';

/** Splits a `gs://bucket/prefix` location (scheme optional, mirroring how
 *  `parseS3Path` tolerates a bare `bucket/prefix`) into its two parts. The
 *  body lives in the import-free `gcs-bucket-name.ts` (`splitGcsLocation`)
 *  so the config validator shares it; this name stays for existing callers.
 *  Does NOT validate the bucket — see `isValidGcsBucketName`. */
export function parseGcsPath(gcsPath: string): { bucket: string; prefix: string } {
  return splitGcsLocation(gcsPath);
}

// Moved to their own import-free module so `browser.ts` can share them with
// the renderer without dragging node built-ins in. Re-exported here because
// this is where every existing importer expects to find them.
export {
  isGcloudCliAccountError,
  isGcloudDownloadFailure,
  isGcpBucketListDeniedMessage,
  isGcpCredentialError,
} from './gcp-credential-errors.js';

/** GCS object size arrives as a string on the REST metadata (JSON numbers
 *  can't hold a 64-bit size), and the SDK types it as `string | number`.
 *  Anything unparseable becomes 0 rather than NaN — a bad size must not
 *  poison the inventory's byte totals. */
function toSize(value: string | number | undefined): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Read-only handle over one GCS bucket. Sister of `createS3Handle`: the SDK
 *  is imported lazily so a workspace with no GCP provider never pays for
 *  loading it.
 *
 *  `contentHash` is the object's CRC32C, which GCS recomputes on every write
 *  — a content hash, exactly like the S3 ETag it stands in for. Generation
 *  is deliberately NOT mixed in: the exporter rewrites a period's folder
 *  wholesale, so a generation-based hash would report every re-export as
 *  changed even when the bytes are identical. */
export async function createGcsHandle(auth: GcsStorageOptions = {}): Promise<ObjectStoreHandle> {
  const storage = await createGcsStorage(auth);

  return {
    async listFiles(bucket: string, prefix: string): Promise<ManifestFileEntry[]> {
      // The SDK puts the bucket in its request URL unencoded, so a name with
      // `\`, `#`, `?` or `%` would list a different bucket than the one the
      // config shows. Config load already rejects such names; this is the
      // guard at the sink itself.
      assertValidGcsBucketName(bucket);
      // autoPaginate walks nextPageToken internally and resolves with the
      // full set — the pagination loop `createS3Handle` writes by hand.
      const [files] = await storage.bucket(bucket).getFiles({ prefix, autoPaginate: true });

      const entries: ManifestFileEntry[] = [];
      for (const file of files) {
        if (!file.name.endsWith('.parquet')) continue;
        entries.push({
          key: file.name,
          contentHash: file.metadata.crc32c ?? '',
          size: toSize(file.metadata.size),
        });
      }
      return entries;
    },

    async downloadFile(bucket: string, key: string, localPath: string, options?: DownloadOptions): Promise<void> {
      assertValidGcsBucketName(bucket);
      await mkdir(dirname(localPath), { recursive: true });

      const sourceStream = storage.bucket(bucket).file(key).createReadStream();
      const writeStream = createWriteStream(localPath);

      if (options?.onBytes === undefined) {
        await pipeline(sourceStream, writeStream, { signal: options?.signal });
        return;
      }

      const onBytes = options.onBytes;
      let totalBytes = 0;
      const progressStream = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          totalBytes += chunk.byteLength;
          onBytes(totalBytes);
          callback(null, chunk);
        },
      });

      await pipeline(sourceStream, progressStream, writeStream, { signal: options.signal });
    },
  };
}
