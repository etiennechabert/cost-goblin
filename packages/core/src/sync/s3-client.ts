import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { dirname } from 'node:path';
import { getProfileName, loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import type { ManifestFileEntry } from './manifest.js';
import type { DownloadOptions, ObjectStoreHandle } from './object-store.js';

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

/** Region a client starts in when neither the caller nor the profile names one. */
const DEFAULT_S3_REGION = 'eu-central-1';

export interface S3ClientBaseConfig {
  readonly region: string;
  readonly followRegionRedirects: true;
  readonly profile?: string;
}

/** The ~/.aws/config profile the SDK's credential chain reads for a
 *  configured profile name. `'default'` names no profile: the chain resolves
 *  it through `AWS_PROFILE` (`getProfileName` is the SDK's own resolution),
 *  so anything read from the config for it has to follow the same rule, or
 *  the credentials and the region come from two different profiles. */
export function credentialChainProfile(profile: string): string {
  return profile === 'default' ? getProfileName({}) : profile;
}

/** The region ~/.aws/config gives a profile: its own `region`, else the
 *  `sso_region` SSO-only profiles carry instead (often omitting `region`):
 *  in the profile itself for the legacy format `aws configure sso` writes
 *  without a session name, or in its linked sso-session. `'default'` reads
 *  the profile `AWS_PROFILE` names (see `credentialChainProfile`). Read
 *  through the SDK's own loader with `ignoreCache`, so a profile edited since
 *  launch counts; it resolves to empty maps for a missing or unreadable file
 *  and never rejects. `AWS_REGION` is deliberately not consulted: it would
 *  outrank the profile, which bites orgs whose SCPs deny regions the profile
 *  was set up to avoid. */
export async function profileRegion(profile: string): Promise<string | undefined> {
  const { configFile } = await loadSharedConfigFiles({ ignoreCache: true });
  const section = configFile[credentialChainProfile(profile)] ?? {};
  const nonEmpty = (value: unknown): string | undefined => typeof value === 'string' && value.length > 0 ? value : undefined;
  const own = nonEmpty(section['region']) ?? nonEmpty(section['sso_region']);
  if (own !== undefined) return own;
  const ssoSession = nonEmpty(section['sso_session']);
  return ssoSession === undefined ? undefined : nonEmpty(configFile[`sso-session.${ssoSession}`]?.['sso_region']);
}

/** The options every `S3Client` the app builds starts from.
 *
 *  Nothing in the config records a bucket's region, so a client has to guess
 *  where to send its first request: the caller's `region` if it names one,
 *  else the profile's own (exports usually live in the region the profile was
 *  set up for, and an org that denies other regions by SCP has set it to one
 *  it allows), else eu-central-1. A wrong guess costs one round trip, not the
 *  call: `followRegionRedirects` makes the SDK read the bucket's region off
 *  S3's 301 PermanentRedirect ("The bucket you are attempting to access must
 *  be addressed using the specified endpoint") and retry there. Without it,
 *  the wizard could not browse an eu-west-1 export, and the sync's inventory
 *  listing could not see it either. `aws s3 sync` needs no equivalent; the CLI
 *  follows the redirect itself.
 *
 *  `profile === 'default'` leaves the profile unset so the SDK's own
 *  credential chain picks it (honouring `AWS_PROFILE`), and `profileRegion`
 *  reads the region from that same profile, so credentials and starting
 *  region never come from two different profiles. `undefined` means no
 *  profile at all: the caller supplies explicit credentials instead, so no
 *  profile region is looked up either. */
export async function s3ClientConfig(profile: string | undefined, region?: string): Promise<S3ClientBaseConfig> {
  const start = region ?? (profile === undefined ? undefined : await profileRegion(profile));
  return {
    region: start ?? DEFAULT_S3_REGION,
    followRegionRedirects: true,
    ...(profile === undefined || profile === 'default' ? {} : { profile }),
  };
}

/** Whether an error indicates missing or expired AWS credentials (expired SSO
 *  token, no resolvable profile) rather than a genuine S3/network failure.
 *  Covers both AWS SDK errors (the inventory listing) and the `aws s3 sync`
 *  CLI's stderr signatures (the download path), so credential expiry is
 *  surfaced consistently across both. Shared by the desktop sync handlers and
 *  the auto-sync scheduler.
 *
 *  The message tests are deliberately AWS-specific phrases rather than a bare
 *  `'credentials'` substring: since #517 a GCP failure ("Could not load the
 *  default credentials") reaches the same classifiers, and a bare match would
 *  rewrite it into "run aws sso login --profile undefined" before
 *  `isGcpCredentialError` ever got a look. */
export function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === 'CredentialsProviderError' || name === 'TokenProviderError') return true;
  const msg = err.message;
  return (
    // AWS SDK credential-resolution failures.
    msg.includes('Token is expired') ||
    msg.includes('SSO session') ||
    msg.includes('Could not load credentials') ||
    msg.includes('resolve credentials') ||
    msg.includes('Resolved credentials are not valid') ||
    // Round-trip of this app's own rewritten message (toUserFriendlyError).
    msg.includes('AWS credentials') ||
    // `aws s3 sync` CLI credential/SSO failures arrive as stderr text rather
    // than SDK error names, so the CLI download path classifies them too.
    msg.includes('Error loading SSO Token') ||
    msg.includes('Token has expired and refresh failed') ||
    msg.includes('ExpiredToken') ||
    msg.includes('InvalidGrantException') ||
    msg.includes('Unable to locate credentials') ||
    msg.includes('aws sso login') ||
    // Catch-all for the wordings not enumerated above — botocore alone emits
    // "Partial credentials found in env, missing: …" and "Error when
    // retrieving credentials from custom-process". Losing those to the
    // narrowing above meant `data:inventory` fell through to the LOCAL
    // inventory and presented stale on-disk periods as a successful sync,
    // with no error and no sign-in button.
    //
    // Guarded against the GCP arm rather than dropped: this classifier and
    // `isGcpCredentialError` share one error channel, and Google's "Could not
    // load the default credentials" would otherwise be rewritten into
    // "run aws sso login --profile undefined".
    (/credential/i.test(msg) && !mentionsGcp(msg))
  );
}

/** Whether a message belongs to the GCP arm. Kept next to `isCredentialError`
 *  because it exists only to stop the AWS catch-all above from claiming a GCP
 *  failure — the two classifiers are fed from the same channel. */
function mentionsGcp(msg: string): boolean {
  return (
    msg.includes('default credentials') ||
    msg.includes('gcloud') ||
    msg.includes('google') ||
    msg.includes('Google')
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

/** The handle shape moved to `object-store.ts` in #517 — it never had
 *  anything S3-specific in it. Re-exported under the historical names so the
 *  S3 call sites (and the public `@costgoblin/core` surface) read unchanged. */
export type { DownloadOptions } from './object-store.js';
export type S3Handle = ObjectStoreHandle;

export async function createS3Handle(profile: string, region?: string, endpointOptions?: S3EndpointOptions): Promise<ObjectStoreHandle> {
  const { S3Client, ListObjectsV2Command, GetObjectCommand } = await getS3Module();

  // Explicit credentials (a custom endpoint such as MinIO) replace the profile.
  const credentials = endpointOptions?.credentials;
  const client = new S3Client({
    ...(await s3ClientConfig(credentials === undefined ? profile : undefined, region)),
    ...(credentials === undefined ? {} : { credentials }),
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
