import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { dirname } from 'node:path';
import type { ManifestFileEntry } from './manifest.js';
import type { DownloadOptions, ObjectStoreHandle } from './object-store.js';

/** Splits a `gs://bucket/prefix` location (scheme optional, mirroring how
 *  `parseS3Path` tolerates a bare `bucket/prefix`) into its two parts. */
export function parseGcsPath(gcsPath: string): { bucket: string; prefix: string } {
  const stripped = gcsPath.replace(/^gs:\/\//, '');
  const slashIdx = stripped.indexOf('/');
  if (slashIdx === -1) {
    return { bucket: stripped, prefix: '' };
  }
  return {
    bucket: stripped.slice(0, slashIdx),
    prefix: stripped.slice(slashIdx + 1),
  };
}

async function getStorageModule(): Promise<typeof import('@google-cloud/storage')> {
  return import('@google-cloud/storage');
}

/** Listing and reading billing exports never needs write access, so the
 *  handle asks for the narrowest Cloud Storage scope. With a service-account
 *  key this is what the token is minted for; under Application Default
 *  Credentials the user-account token already carries cloud-platform, and
 *  the scope is simply not narrowed further. */
const READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';

/** Whether an error indicates missing or expired GCP credentials rather than
 *  a genuine storage/network failure. Mirrors `isCredentialError` on the AWS
 *  side and covers both shapes the app sees: google-auth-library failures
 *  from the listing SDK, and `gcloud storage` CLI stderr from the download
 *  path.
 *
 *  Deliberately narrow on 401/403: a bare "403" from a *successful* auth
 *  handshake means the principal lacks `storage.objects.list`, which is a
 *  permissions bug the user fixes in IAM, not by re-authenticating. Only the
 *  documented credential-resolution signatures classify as credential
 *  errors. */
export function isGcpCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    // google-auth-library: no ADC file, no metadata server, malformed key.
    msg.includes('Could not load the default credentials') ||
    msg.includes('Could not refresh access token') ||
    msg.includes('Unable to detect a Project Id') ||
    msg.includes('invalid_grant') ||
    msg.includes('invalid_rapt') ||
    msg.includes('Token has been expired or revoked') ||
    // `gcloud` CLI stderr, both the reauth and the never-authed cases.
    msg.includes('gcloud auth application-default login') ||
    msg.includes('gcloud auth login') ||
    msg.includes('Your credentials are invalid') ||
    msg.includes('Reauthentication failed') ||
    msg.includes('does not have any valid credentials')
  );
}

/** A `gcloud storage rsync` download that failed without an explicit
 *  credential signature — retries exhausted, connection reset. Sister of
 *  `isS3SyncDownloadFailure`: for an ADC-backed bucket this is usually an
 *  expired session, but it can equally be a network drop, so callers surface
 *  a "session may have expired, or check your connection" hint rather than a
 *  definite credential error. Scoped to the CLI failure message so it never
 *  misclassifies an SDK error. */
export function isGcloudDownloadFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg.includes('gcloud storage rsync failed')) return false;
  return (
    msg.includes('Max retries exceeded') ||
    msg.includes('Connection reset') ||
    msg.includes('Could not reach') ||
    msg.includes('ServiceUnavailable') ||
    msg.includes('503')
  );
}

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
export async function createGcsHandle(keyFile?: string): Promise<ObjectStoreHandle> {
  const { Storage } = await getStorageModule();

  const storage = new Storage({
    scopes: [READ_ONLY_SCOPE],
    ...(keyFile === undefined ? {} : { keyFilename: keyFile }),
  });

  return {
    async listFiles(bucket: string, prefix: string): Promise<ManifestFileEntry[]> {
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
