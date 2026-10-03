import type { Storage } from '@google-cloud/storage';

/** Listing and reading billing exports never needs write access, so every
 *  Storage client asks for the narrowest Cloud Storage scope. With a
 *  service-account key, or under impersonation, this is what the token is
 *  minted for; under plain Application Default Credentials the user-account
 *  token already carries cloud-platform, and the scope is simply not narrowed
 *  further. */
export const GCS_READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';

/** What the SOURCE credential of an impersonation must carry: minting a token
 *  for another principal is an IAM Credentials API call, which accepts
 *  cloud-platform only. A user's ADC refresh token already has it. */
const IAM_CREDENTIALS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** One impersonated token lives an hour — the API's default ceiling, and the
 *  client refreshes it transparently from the source credential. */
const IMPERSONATED_TOKEN_LIFETIME_SECONDS = 3600;

export interface GcsStorageOptions {
  /** Billing / quota project. Only the setup wizard's project-scoped calls
   *  (`getBuckets`) need it; bucket-addressed calls ignore it. */
  readonly projectId?: string | undefined;
  /** A service-account key file. Replaces ADC for this client. */
  readonly keyFile?: string | undefined;
  /** A service account to read AS, on top of Application Default Credentials.
   *  Per client, so two providers can read with two different accounts while
   *  sharing one machine-wide `gcloud auth application-default login`. */
  readonly impersonateServiceAccount?: string | undefined;
}

/** Build a read-only Cloud Storage client for one provider's identity.
 *
 *  The single place a GCS `Storage` is constructed — the sync's listing half
 *  and the setup wizard's bucket browser both come through here, so the
 *  identity the wizard browses with is the one the sync will list with.
 *
 *  With `impersonateServiceAccount` the client authenticates as that service
 *  account, minted from ADC as the source credential. ADC is ONE file per
 *  machine, so impersonation cannot live in it (the old
 *  `application-default login --impersonate-service-account` recipe) without
 *  locking every other GCP provider out; carried per client instead, ADC stays
 *  the user's own login and each provider names its own reader. The user
 *  needs `roles/iam.serviceAccountTokenCreator` on each reader — the same grant
 *  `gcloud storage rsync --impersonate-service-account` already requires for
 *  the download half.
 *
 *  Both SDKs are imported lazily so a workspace with no GCP provider never
 *  loads them. */
export async function createGcsStorage(options: GcsStorageOptions): Promise<Storage> {
  const { keyFile, impersonateServiceAccount, projectId } = options;
  if (keyFile !== undefined && impersonateServiceAccount !== undefined) {
    // The validator rejects this pair at config load; re-checked here because
    // the auth crosses a worker-thread boundary as loose data, and a key file
    // silently winning would list as a different identity than the download.
    throw new Error('keyFile and impersonateServiceAccount are mutually exclusive — pick one');
  }

  const base = {
    scopes: [GCS_READ_ONLY_SCOPE],
    ...(projectId === undefined ? {} : { projectId }),
  };

  const { Storage } = await import('@google-cloud/storage');
  if (impersonateServiceAccount === undefined) {
    return new Storage({ ...base, ...(keyFile === undefined ? {} : { keyFilename: keyFile }) });
  }

  const { GoogleAuth, Impersonated } = await import('google-auth-library');
  const source = await new GoogleAuth({ scopes: [IAM_CREDENTIALS_SCOPE] }).getClient();
  // A machine still on the legacy recipe has ADC that IS an impersonation of
  // this very account. Wrapping it again would ask the reader for permission
  // to impersonate itself, which nobody grants — so use it as-is. ADC that
  // impersonates a DIFFERENT account is chained from (and fails loudly with
  // the IAM denial) rather than used, which would read as the wrong identity.
  if (source instanceof Impersonated && source.getTargetPrincipal() === impersonateServiceAccount) {
    return new Storage({ ...base, authClient: source });
  }
  const authClient = new Impersonated({
    sourceClient: source,
    targetPrincipal: impersonateServiceAccount,
    targetScopes: [GCS_READ_ONLY_SCOPE],
    lifetime: IMPERSONATED_TOKEN_LIFETIME_SECONDS,
  });
  return new Storage({ ...base, authClient });
}
