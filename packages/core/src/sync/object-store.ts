import { createGcsHandle, parseGcsPath } from './gcs-client.js';
import { createS3Handle, parseS3Path } from './s3-client.js';
import type { ManifestFileEntry } from './manifest.js';
import type { ProviderConfig } from '../types/config.js';

export interface DownloadOptions {
  onBytes?: ((bytesReceived: number) => void) | undefined;
  signal?: AbortSignal | undefined;
}

/** The read surface the sync layer needs from a provider's object store.
 *  Deliberately transport-neutral: `listFiles` drives change detection and
 *  the data inventory, `downloadFile` fetches a single object (the setup
 *  wizard's schema probe). Bulk period downloads do NOT go through here —
 *  they shell out to the provider's own CLI (`aws s3 sync` /
 *  `gcloud storage rsync`), which handles parallelism, retries and resume
 *  far better than anything we would write.
 *
 *  Named `S3Handle` until #517; the shape never had anything S3-specific
 *  in it. `S3Handle` remains an alias so existing S3 call sites read
 *  naturally. */
export interface ObjectStoreHandle {
  listFiles(bucket: string, prefix: string): Promise<ManifestFileEntry[]>;
  downloadFile(bucket: string, key: string, localPath: string, options?: DownloadOptions): Promise<void>;
}

/** How one provider authenticates to its object store, derived from the
 *  config arm. Threaded through the whole sync stack including the
 *  worker-thread boundary, so it stays a plain discriminated union of
 *  primitives that survives structured cloning.
 *
 *  `gcp` with no `keyFile` means Application Default Credentials — the
 *  documented default, established by `gcloud auth application-default
 *  login`. */
export type ProviderAuth =
  | { readonly kind: 'aws-profile'; readonly profile: string }
  | { readonly kind: 'gcp'; readonly keyFile?: string | undefined; readonly impersonateServiceAccount?: string | undefined };

export function providerAuth(provider: ProviderConfig): ProviderAuth {
  if (provider.type === 'gcp') {
    return {
      kind: 'gcp',
      ...(provider.keyFile === undefined ? {} : { keyFile: provider.keyFile }),
      ...(provider.impersonateServiceAccount === undefined ? {} : { impersonateServiceAccount: provider.impersonateServiceAccount }),
    };
  }
  return { kind: 'aws-profile', profile: provider.credentialsProfile };
}

/** Open a read handle against the store the given auth belongs to. Importing
 *  the client modules costs nothing: each keeps its provider SDK behind a
 *  dynamic import inside its own `create…Handle`, so a workspace with no GCP
 *  provider never loads the GCS SDK (and vice versa). */
export async function createObjectStoreHandle(auth: ProviderAuth): Promise<ObjectStoreHandle> {
  // `impersonateServiceAccount` is deliberately not forwarded: it is a gcloud
  // CLI flag for the download half, while this half reads Application Default
  // Credentials — which already carry the impersonation, because the documented
  // way to establish them is
  // `gcloud auth application-default login --impersonate-service-account=<sa>`.
  // The validator rejects `keyFile` + `impersonateServiceAccount` together, so
  // the case where a key file would displace that ADC cannot reach here.
  if (auth.kind === 'gcp') return createGcsHandle(auth.keyFile);
  return createS3Handle(auth.profile);
}

/** Split a configured bucket location into bucket + prefix using the scheme
 *  rules of the provider it belongs to. Both parsers tolerate a bare
 *  `bucket/prefix` with no scheme. */
export function parseObjectPath(auth: ProviderAuth, bucketPath: string): { bucket: string; prefix: string } {
  return auth.kind === 'gcp' ? parseGcsPath(bucketPath) : parseS3Path(bucketPath);
}

/** Re-validate a `ProviderAuth` that crossed a worker-thread (or IPC)
 *  boundary. The union is structurally cloned, so nothing guarantees the
 *  received value still has the shape the type claims. */
export function isProviderAuth(value: unknown): value is ProviderAuth {
  if (typeof value !== 'object' || value === null) return false;
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  if (record['kind'] === 'aws-profile') return typeof record['profile'] === 'string';
  if (record['kind'] === 'gcp') {
    const keyFileOk = record['keyFile'] === undefined || typeof record['keyFile'] === 'string';
    const impersonateOk = record['impersonateServiceAccount'] === undefined || typeof record['impersonateServiceAccount'] === 'string';
    return keyFileOk && impersonateOk;
  }
  return false;
}
