import type { Storage } from '@google-cloud/storage';
import type { AuthClient, GoogleAuth, JWTInput } from 'google-auth-library';
import { isStringRecord } from '../utils/json.js';

/** Listing and reading billing exports never needs write access, so every
 *  client is minted for the narrowest Cloud Storage scope. It has to go on the
 *  credential itself: `@google-cloud/storage` ignores a `scopes` option and
 *  asks for its own hard-coded full_control + cloud-platform. (A user's ADC
 *  refresh token carries the scopes it was consented with whatever is asked,
 *  so for plain ADC this narrows nothing; for key files and impersonation it
 *  does.) */
export const GCS_READ_ONLY_SCOPE = 'https://www.googleapis.com/auth/devstorage.read_only';

/** What the SOURCE credential of an impersonation must carry: minting a token
 *  for another principal is an IAM Credentials API call, which accepts
 *  cloud-platform only. */
const IAM_CREDENTIALS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface GcsStorageOptions {
  /** The project the wizard's `getBuckets` lists. Bucket-addressed calls
   *  ignore it; it also spares google-auth-library its project-id discovery
   *  (a PATH-resolved `gcloud` exec, then a GCE metadata probe). */
  readonly projectId?: string | undefined;
  /** A service-account key file. Replaces ADC for this client. */
  readonly keyFile?: string | undefined;
  /** A service account to read AS, minted from the user's own Application
   *  Default Credentials. Per client, so two providers can read with two
   *  different accounts while sharing one machine-wide ADC login. */
  readonly impersonateServiceAccount?: string | undefined;
}

/** `name@<project>.iam.gserviceaccount.com` → `<project>`. Handed to
 *  GoogleAuth only to skip its project-id discovery; the address grammar is
 *  enforced at config load. */
function serviceAccountProject(serviceAccount: string): string | undefined {
  const match = /@([^.@]+)\.iam\.gserviceaccount\.com$/.exec(serviceAccount);
  return match?.[1];
}

const JWT_INPUT_KEYS: readonly (keyof JWTInput)[] = [
  'type', 'client_email', 'private_key', 'private_key_id', 'project_id',
  'client_id', 'client_secret', 'refresh_token', 'quota_project_id', 'universe_domain',
];

/** The `source_credentials` of an ADC file written by
 *  `application-default login --impersonate-service-account` — the user's own
 *  login that file impersonates FROM. Null for any other ADC. */
function legacySourceCredentials(content: unknown): JWTInput | null {
  if (!isStringRecord(content) || content['type'] !== 'impersonated_service_account') return null;
  const source = content['source_credentials'];
  if (!isStringRecord(source)) return null;
  const input: JWTInput = {};
  for (const key of JWT_INPUT_KEYS) {
    const value = source[key];
    if (typeof value === 'string') input[key] = value;
  }
  return input;
}

/** The credential every reader is minted from: ADC, unwrapped when it is
 *  itself an impersonation (machines set up with the old
 *  `--impersonate-service-account` ADC recipe). Minting from that wrapper
 *  would ask ITS service account for the right to impersonate this provider's
 *  reader — which nobody grants, and which the resulting denial would blame on
 *  the user. The user's own login underneath is what holds the grant. */
async function userSourceClient(adc: GoogleAuth): Promise<AuthClient> {
  const client = await adc.getClient();
  const legacy = legacySourceCredentials(adc.jsonContent);
  if (legacy === null) return client;
  const source = adc.fromJSON(legacy);
  // `fromJSON` skips the override `getClient` applies to ADC it loads itself;
  // the mint is billed to this project, so honour it the same way.
  const quotaOverride = process.env['GOOGLE_CLOUD_QUOTA_PROJECT'];
  if (quotaOverride !== undefined && quotaOverride !== '') source.quotaProjectId = quotaOverride;
  return source;
}

/** Build a read-only Cloud Storage client for one provider's identity.
 *
 *  The single place a GCS `Storage` is constructed — the sync's listing half
 *  and the setup wizard's bucket browser both come through here, so the
 *  identity the wizard browses with is the one the sync will list with.
 *
 *  With `impersonateServiceAccount` the client authenticates as that service
 *  account, minted from the user's ADC login — the same model as the download
 *  half's `gcloud storage rsync --impersonate-service-account`. ADC is ONE
 *  file per machine, so carrying the reader per client is what lets two
 *  providers read as two accounts. The user needs
 *  `roles/iam.serviceAccountTokenCreator` on each reader.
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

  const [{ Storage }, { GoogleAuth, Impersonated }] = await Promise.all([
    import('@google-cloud/storage'),
    import('google-auth-library'),
  ]);
  const base = projectId === undefined ? {} : { projectId };

  if (impersonateServiceAccount === undefined) {
    const authClient = new GoogleAuth({
      ...base,
      scopes: [GCS_READ_ONLY_SCOPE],
      ...(keyFile === undefined ? {} : { keyFilename: keyFile }),
    });
    return new Storage({ ...base, authClient });
  }

  const sourceProject = projectId ?? serviceAccountProject(impersonateServiceAccount);
  const adc = new GoogleAuth({
    scopes: [IAM_CREDENTIALS_SCOPE],
    ...(sourceProject === undefined ? {} : { projectId: sourceProject }),
  });
  const authClient = new Impersonated({
    sourceClient: await userSourceClient(adc),
    targetPrincipal: impersonateServiceAccount,
    targetScopes: [GCS_READ_ONLY_SCOPE],
  });
  return new Storage({ ...base, authClient });
}
