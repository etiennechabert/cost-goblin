import { describe, it, expect } from 'vitest';
import { isCredentialError, isS3SyncDownloadFailure } from '../sync/s3-client.js';
import { isGcloudCliAccountError, isGcloudDownloadFailure, isGcpBucketListDeniedMessage, isGcpCredentialError } from '../sync/gcs-client.js';
import { describeGcpImpersonationFailure, isGcpImpersonationError, isGcpNetworkError } from '../sync/gcp-credential-errors.js';

/** The verbatim denial a live least-privilege reader produces on the wizard's
 *  bucket step — `roles/storage.objectViewer` on the bucket, nothing at the
 *  project level. Kept whole, Troubleshooter URL and all, because its length
 *  and shape are the reason the raw text is replaced rather than shown. */
const BUCKET_LIST_DENIED =
  "costgoblin-reader@billing-504501.iam.gserviceaccount.com does not have storage.buckets.list access to the Google Cloud project. "
  + "Permission 'storage.buckets.list' denied on resource (or it may not exist). Remediate access with this Troubleshooter URL or share "
  + 'it with your administrator - https://console.cloud.google.com/iam-admin/troubleshooter/summary;errorId=CiQwMTlmZTAwMS01MmYxLTc4NDQ.';

/** Every AWS message the suite asserts on, reused as cross-negatives for the
 *  GCP classifiers (and vice versa). The two provider paths share one error
 *  channel, so a message that classifies as both would send the user to the
 *  wrong sign-in command. */
const AWS_CREDENTIAL_MESSAGES = [
  'Token is expired',
  'The SSO session associated with this profile has expired',
  'Could not load credentials from any providers',
  'AWS credentials expired for profile "prod". Run: aws sso login --profile prod',
  'aws s3 sync failed (exit 1): Error loading SSO Token: Token for solaris does not exist',
  'aws s3 sync failed (exit 1): Token has expired and refresh failed',
  'aws s3 sync failed (exit 255): An error occurred (ExpiredToken) when calling GetObject',
  'aws s3 sync failed (exit 1): InvalidGrantException',
  'aws s3 sync failed (exit 1): Unable to locate credentials',
];

const GCP_CREDENTIAL_MESSAGES = [
  'Could not load the default credentials. Browse to https://cloud.google.com/docs/authentication/getting-started',
  'Could not refresh access token: invalid_grant',
  'GCP credentials are missing or expired. Run: gcloud auth application-default login',
  'gcloud storage rsync failed (exit 1): Your credentials are invalid. Please run $ gcloud auth login',
  'Token has been expired or revoked.',
  'Reauthentication failed. cannot prompt during non-interactive execution.',
];

describe('isCredentialError', () => {
  it('detects credential / token provider errors by name', () => {
    const credErr = new Error('boom');
    credErr.name = 'CredentialsProviderError';
    const tokenErr = new Error('boom');
    tokenErr.name = 'TokenProviderError';
    expect(isCredentialError(credErr)).toBe(true);
    expect(isCredentialError(tokenErr)).toBe(true);
  });

  it('detects expired-token / SSO / credentials messages', () => {
    expect(isCredentialError(new Error('Token is expired'))).toBe(true);
    expect(isCredentialError(new Error('The SSO session associated with this profile has expired'))).toBe(true);
    expect(isCredentialError(new Error('Could not load credentials from any providers'))).toBe(true);
    // The friendly message we rewrite credential failures into must still
    // classify as a credential error so the auto-sync scheduler surfaces it.
    expect(isCredentialError(new Error('AWS credentials expired for profile "prod". Run: aws sso login --profile prod'))).toBe(true);
  });

  it('detects aws CLI SSO / credential failures from `aws s3 sync` stderr', () => {
    // The CLI reports these as stderr text (no SDK error name), folded into
    // `aws s3 sync failed (exit N): <stderr>` by runAwsS3Sync.
    expect(isCredentialError(new Error('aws s3 sync failed (exit 1): Error loading SSO Token: Token for solaris does not exist'))).toBe(true);
    expect(isCredentialError(new Error('aws s3 sync failed (exit 1): Token has expired and refresh failed'))).toBe(true);
    expect(isCredentialError(new Error('aws s3 sync failed (exit 255): An error occurred (ExpiredToken) when calling GetObject'))).toBe(true);
    expect(isCredentialError(new Error('aws s3 sync failed (exit 1): InvalidGrantException'))).toBe(true);
    expect(isCredentialError(new Error('aws s3 sync failed (exit 1): Unable to locate credentials'))).toBe(true);
  });

  it('does not flag unrelated errors or non-errors', () => {
    expect(isCredentialError(new Error('Access Denied: s3:ListBucket'))).toBe(false);
    expect(isCredentialError(new Error('NetworkError: request timed out'))).toBe(false);
    // An opaque retry-exhaustion download failure is NOT a definite credential
    // error — it routes through isS3SyncDownloadFailure instead.
    expect(isCredentialError(new Error('aws s3 sync failed (exit 1): download failed: s3://b/k Max Retries Exceeded'))).toBe(false);
    expect(isCredentialError('a string')).toBe(false);
    expect(isCredentialError(null)).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
  });

  it('still catches AWS credential wordings that are not enumerated', () => {
    // Narrowing the old bare `includes('credentials')` to a fixed phrase list
    // dropped these. The cost was silent: `data:inventory` stopped classifying
    // them, fell through to the LOCAL inventory, and presented stale on-disk
    // periods as a successful sync — no error, and no sign-in button.
    expect(isCredentialError(new Error('Partial credentials found in env, missing: AWS_SECRET_ACCESS_KEY'))).toBe(true);
    expect(isCredentialError(new Error('Error when retrieving credentials from custom-process: exit status 1'))).toBe(true);
    expect(isCredentialError(new Error('The config profile (prod) could not be found'))).toBe(false);
  });

  it('does not claim GCP credential failures', () => {
    // Before #517 a bare `msg.includes('credentials')` matched Google's
    // "Could not load the default credentials", so every GCP auth failure was
    // rewritten into "run aws sso login --profile undefined".
    for (const msg of GCP_CREDENTIAL_MESSAGES) {
      expect(isCredentialError(new Error(msg)), msg).toBe(false);
    }
  });
});

describe('isGcpCredentialError', () => {
  it('detects google-auth-library and gcloud CLI credential failures', () => {
    for (const msg of GCP_CREDENTIAL_MESSAGES) {
      expect(isGcpCredentialError(new Error(msg)), msg).toBe(true);
    }
  });

  it('does not claim AWS credential failures', () => {
    for (const msg of AWS_CREDENTIAL_MESSAGES) {
      expect(isGcpCredentialError(new Error(msg)), msg).toBe(false);
    }
  });

  it('does not flag permission errors, unrelated errors, or non-errors', () => {
    // A 403 from an authenticated principal is an IAM grant the user fixes in
    // the console — re-authenticating would not help, so it must not be
    // classified as a credential error.
    expect(isGcpCredentialError(new Error('storage.objects.list access to the Google Cloud Storage object is denied (403)'))).toBe(false);
    expect(isGcpCredentialError(new Error('NetworkError: request timed out'))).toBe(false);
    expect(isGcpCredentialError('a string')).toBe(false);
    expect(isGcpCredentialError(null)).toBe(false);
    expect(isGcpCredentialError(undefined)).toBe(false);
  });
});

describe('isGcpBucketListDeniedMessage', () => {
  it('detects both shapes of the buckets.list denial', () => {
    expect(isGcpBucketListDeniedMessage(BUCKET_LIST_DENIED)).toBe(true);
    expect(isGcpBucketListDeniedMessage("Permission 'storage.buckets.list' denied on resource")).toBe(true);
    expect(isGcpBucketListDeniedMessage('reader@p.iam.gserviceaccount.com does not have storage.buckets.list access')).toBe(true);
  });

  it('does not claim credential failures, object denials, or the empty message', () => {
    // Signing in again cannot grant a permission, so the credential branch and
    // this one must stay disjoint — sharing a branch would offer a sign-in
    // button for an IAM grant.
    for (const msg of [...AWS_CREDENTIAL_MESSAGES, 'Could not load the default credentials', 'Reauthentication failed']) {
      expect(isGcpBucketListDeniedMessage(msg), msg).toBe(false);
    }
    // An OBJECT denial is a genuine misconfiguration — the reader cannot walk
    // the bucket at all, so the "type the name instead" remedy does not apply.
    expect(isGcpBucketListDeniedMessage('does not have storage.objects.list access')).toBe(false);
    // The wizard calls this on every render, including before any request has
    // run, so the no-error case must not light up the panel.
    expect(isGcpBucketListDeniedMessage('')).toBe(false);
  });

  it('is not classified as a credential error', () => {
    expect(isGcpCredentialError(new Error(BUCKET_LIST_DENIED))).toBe(false);
  });
});

describe('isGcpImpersonationError', () => {
  // The shapes the app really sees. google-auth-library's
  // `Impersonated.refreshToken` rewrites the IAM failure to
  // `<STATUS>: unable to impersonate: <message>`, and for a 403/404
  // `OAuth2Client.getRequestMetadataAsync` then prefixes
  // `Could not refresh access token: ` — the same prefix an expired login
  // carries, which is why it cannot be the deciding marker.
  const TOKEN_CREATOR_MISSING = "Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Permission 'iam.serviceAccounts.getAccessToken' denied on resource (or it may not exist).";
  const API_DISABLED = 'Could not refresh access token: PERMISSION_DENIED: unable to impersonate: IAM Service Account Credentials API has not been used in project 123 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/iamcredentials.googleapis.com/overview?project=123';
  const NO_SUCH_READER = 'Could not refresh access token: NOT_FOUND: unable to impersonate: Not found; Gaia id not found for email costgoblin-raeder@proj.iam.gserviceaccount.com';
  const QUOTA_PROJECT_DENIED = 'Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Caller does not have required permission to use project quota-proj. Grant the caller the roles/serviceusage.serviceUsageConsumer role';
  const GCLOUD_CLI_DENIED = "gcloud storage rsync failed (exit 1): ERROR: (gcloud.storage.rsync) Failed to impersonate [reader@proj.iam.gserviceaccount.com]. Make sure the account that's trying to impersonate it has access to the service account itself and the \"roles/iam.serviceAccountTokenCreator\" role.";
  const DENIALS = [TOKEN_CREATOR_MISSING, API_DISABLED, NO_SUCH_READER, QUOTA_PROJECT_DENIED, GCLOUD_CLI_DENIED];

  it('detects every IAM-side impersonation failure, from either half of a sync', () => {
    for (const msg of DENIALS) expect(isGcpImpersonationError(new Error(msg)), msg).toBe(true);
  });

  it('keeps them out of the credential branch, whose sign-in button cannot grant a role', () => {
    for (const msg of DENIALS) {
      expect(isGcpCredentialError(new Error(msg)), msg).toBe(false);
      expect(isGcpBucketListDeniedMessage(msg), msg).toBe(false);
    }
  });

  it('leaves an expired source login to the credential branch', () => {
    // The user's own refresh token failing arrives under the same wrapper —
    // and a sign-in DOES fix that one.
    for (const expired of [
      'unable to impersonate: Error: invalid_grant: reauth related error (invalid_rapt)',
      'unable to impersonate: Error: invalid_grant: Token has been expired or revoked.',
    ]) {
      expect(isGcpImpersonationError(new Error(expired)), expired).toBe(false);
      expect(isGcpCredentialError(new Error(expired)), expired).toBe(true);
    }
  });

  it('leaves transient mint failures to the caller\'s ordinary retry path', () => {
    // Impersonated.refreshToken wraps EVERY failure — offline, 5xx, rate
    // limits — in the same `unable to impersonate:` text. Only an IAM-side
    // answer is a grant problem; the rest must stay a silent skip / local
    // fallback, not a 'grant Token Creator' remedy for a grant that exists.
    for (const transient of [
      'unable to impersonate: GaxiosError: request to https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/r@p.iam.gserviceaccount.com:generateAccessToken failed, reason: getaddrinfo ENOTFOUND iamcredentials.googleapis.com',
      'Could not refresh access token: UNAVAILABLE: unable to impersonate: The service is currently unavailable.',
      'RESOURCE_EXHAUSTED: unable to impersonate: Quota exceeded for quota metric',
    ]) {
      expect(isGcpImpersonationError(new Error(transient)), transient).toBe(false);
    }
  });

  it('leaves a too-narrowly consented ADC login to the credential branch, which a sign-in fixes', () => {
    const narrow = 'Could not refresh access token: PERMISSION_DENIED: unable to impersonate: Request had insufficient authentication scopes. ACCESS_TOKEN_SCOPE_INSUFFICIENT';
    expect(isGcpImpersonationError(new Error(narrow))).toBe(false);
    expect(isGcpCredentialError(new Error(narrow))).toBe(true);
  });

  it('does not claim ordinary credential errors, object denials or non-errors', () => {
    for (const msg of [...GCP_CREDENTIAL_MESSAGES, BUCKET_LIST_DENIED, 'storage.objects.list access denied (403)']) {
      expect(isGcpImpersonationError(new Error(msg)), msg).toBe(false);
    }
    expect(isGcpImpersonationError('unable to impersonate')).toBe(false);
  });

  it('is still recognised after describeGcpImpersonationFailure rewrites it', () => {
    // The scheduler and the inventory fallback re-classify the REWRITTEN error.
    const rewritten = new Error(describeGcpImpersonationFailure('reader@proj.iam.gserviceaccount.com', TOKEN_CREATOR_MISSING));
    expect(isGcpImpersonationError(rewritten)).toBe(true);
    expect(isGcpCredentialError(rewritten)).toBe(false);
  });
});

describe('describeGcpImpersonationFailure', () => {
  it('names the reader, every cause, and keeps the raw denial', () => {
    const raw = 'Could not refresh access token: NOT_FOUND: unable to impersonate: Not found; Gaia id not found for email reader@proj.iam.gserviceaccount.com';
    const text = describeGcpImpersonationFailure('reader@proj.iam.gserviceaccount.com', raw);
    expect(text).toContain('add-iam-policy-binding reader@proj.iam.gserviceaccount.com');
    expect(text).toContain('roles/iam.serviceAccountTokenCreator');
    expect(text).toMatch(/exists/);
    expect(text).toContain('iamcredentials.googleapis.com');
    expect(text).toMatch(/quota project/);
    expect(text).toContain(raw);
    // No sign-in can fix an IAM grant: the toolbar raises its sign-in button
    // on these markers, so they must stay out.
    expect(text).not.toContain('GCP credentials');
    expect(text).not.toContain('Run: ');
  });

  it('never pastes prose into the command when the reader is unknown', () => {
    const text = describeGcpImpersonationFailure(undefined, 'unable to impersonate: x');
    expect(text).toContain('add-iam-policy-binding <service-account>');
    expect(text).not.toMatch(/add-iam-policy-binding the /);
  });
});

describe('isGcloudDownloadFailure', () => {
  it('detects opaque gcloud retry / connection download failures', () => {
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): Max retries exceeded'))).toBe(true);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): Connection reset by peer'))).toBe(true);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): ServiceUnavailable'))).toBe(true);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): HTTPError 503: Service Unavailable'))).toBe(true);
  });

  it('does not read a 503 out of a shard name or a traceback line number', () => {
    // BigQuery names its shards with twelve zero-padded digits, so `503`
    // appears inside ordinary object keys. A bare `includes('503')` turned a
    // genuine permissions failure into "your session may have expired" and
    // sent the user to re-authenticate for something re-authenticating cannot
    // fix — while the real cause (a missing IAM grant) went unmentioned.
    const perms = 'gcloud storage rsync failed (exit 1): ERROR: gs://b/focus/daily/billing_period=2026-01/shard-000000000503.parquet: '
      + '403 reader@p.iam.gserviceaccount.com does not have storage.objects.get access';
    expect(isGcloudDownloadFailure(new Error(perms))).toBe(false);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): File "cmd.py", line 503, in _RunCommand'))).toBe(false);
  });

  it('is scoped to gcloud storage rsync failures only', () => {
    expect(isGcloudDownloadFailure(new Error('Max retries exceeded'))).toBe(false);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): 403 does not have storage.objects.list access'))).toBe(false);
    // The AWS sibling's messages never cross over.
    expect(isGcloudDownloadFailure(new Error('aws s3 sync failed (exit 1): download failed: s3://b/k Max Retries Exceeded'))).toBe(false);
    expect(isGcloudDownloadFailure('a string')).toBe(false);
    expect(isGcloudDownloadFailure(null)).toBe(false);
  });
});

describe('isGcloudCliAccountError', () => {
  /** Verbatim stderr from a live run: personal ADC, work account active in
   *  gcloud. Listing succeeded; the download failed like this. */
  const LIVE = 'gcloud storage rsync failed (exit 1): WARNING: This command is using service account impersonation. '
    + 'All API calls will be executed as [costgoblin-reader@billing-504501.iam.gserviceaccount.com].\n'
    + 'ERROR: (gcloud.storage.rsync) There was a problem refreshing your current auth tokens: Reauthentication failed. '
    + 'cannot prompt during non-interactive execution.\nPlease run:\n$ gcloud auth login\nto obtain new credentials.\n'
    + 'If you have already logged in with a different account, run:\n$ gcloud config set account ACCOUNT';

  it('detects a stale or mismatched gcloud CLI account', () => {
    expect(isGcloudCliAccountError(new Error(LIVE))).toBe(true);
    expect(isGcloudCliAccountError(new Error('gcloud storage rsync failed (exit 1): You do not currently have an active account selected'))).toBe(true);
  });

  it('outranks isGcpCredentialError, which the same message also matches', () => {
    // Both match — which is exactly why order matters in toUserFriendlyError.
    // ADC is fine here; telling the user to re-run `application-default login`
    // would send them round a loop that never fixes the CLI account.
    expect(isGcpCredentialError(new Error(LIVE))).toBe(true);
    expect(isGcloudCliAccountError(new Error(LIVE))).toBe(true);
  });

  it('is scoped to the gcloud CLI download wrapper only', () => {
    // The ADC failure from the listing SDK must never land here — its fix is
    // the other command.
    expect(isGcloudCliAccountError(new Error('Could not load the default credentials'))).toBe(false);
    // `gcloud auth application-default login` does not contain `gcloud auth login`.
    expect(isGcloudCliAccountError(new Error('gcloud storage rsync failed (exit 1): run gcloud auth application-default login'))).toBe(false);
    expect(isGcloudCliAccountError(new Error('Reauthentication failed'))).toBe(false);
    expect(isGcloudCliAccountError('a string')).toBe(false);
    expect(isGcloudCliAccountError(null)).toBe(false);
  });
});

describe('isS3SyncDownloadFailure', () => {
  it('detects opaque `aws s3 sync` retry / connection download failures', () => {
    expect(isS3SyncDownloadFailure(new Error('aws s3 sync failed (exit 1): download failed: s3://b/k Max Retries Exceeded'))).toBe(true);
    expect(isS3SyncDownloadFailure(new Error('aws s3 sync failed (exit 1): download failed: s3://b/k connection reset'))).toBe(true);
    expect(isS3SyncDownloadFailure(new Error('aws s3 sync failed (exit 255): Could not connect to the endpoint URL'))).toBe(true);
  });

  it('is scoped to aws s3 sync failures only', () => {
    // Not wrapped as an `aws s3 sync failed` error → never matches, even with
    // retry wording, so SDK / other errors are never misclassified.
    expect(isS3SyncDownloadFailure(new Error('Max Retries Exceeded'))).toBe(false);
    // A genuine permission error is not a session / network failure.
    expect(isS3SyncDownloadFailure(new Error('aws s3 sync failed (exit 1): An error occurred (AccessDenied)'))).toBe(false);
    expect(isS3SyncDownloadFailure('a string')).toBe(false);
    expect(isS3SyncDownloadFailure(null)).toBe(false);
  });
});

describe('isGcpNetworkError', () => {
  // Verbatim from a live run: gcloud wraps the unreachable token endpoint in
  // its own "gcloud auth login" advice, which the CLI-account check matches.
  const REFRESH_NO_ROUTE = 'gcloud storage rsync failed (exit 1): WARNING: This command is using service account impersonation.\n'
    + 'ERROR: (gcloud.storage.rsync) There was a problem refreshing your current auth tokens: '
    + "HTTPSConnectionPool(host='oauth2.googleapis.com', port=443): Max retries exceeded with url: /token "
    + '(Caused by NewConnectionError("HTTPSConnection(host=\'oauth2.googleapis.com\', port=443): Failed to establish a new connection: [Errno 65] No route to host"))\n'
    + 'Please run:\n  $ gcloud auth login\nto obtain new credentials.';

  it('recognizes a token refresh that never reached Google, even when gcloud blames the sign-in', () => {
    expect(isGcpNetworkError(new Error(REFRESH_NO_ROUTE))).toBe(true);
    // Why it must be checked first: the CLI-account check matches it too.
    expect(isGcloudCliAccountError(new Error(REFRESH_NO_ROUTE))).toBe(true);
  });

  it.each([
    'request to https://oauth2.googleapis.com/token failed, reason: getaddrinfo ENOTFOUND oauth2.googleapis.com',
    'connect EHOSTUNREACH 142.250.0.95:443',
    'connect ECONNREFUSED 127.0.0.1:443',
    "HTTPSConnectionPool(host='storage.googleapis.com', port=443): [Errno 8] nodename nor servname provided, or not known",
  ])('recognizes %s', (message) => {
    expect(isGcpNetworkError(new Error(message))).toBe(true);
  });

  it('does not claim a refusal Google actually answered', () => {
    expect(isGcpNetworkError(new Error('Could not refresh access token: invalid_grant'))).toBe(false);
    expect(isGcpNetworkError(new Error('gcloud storage rsync failed (exit 1): HTTPError 403: does not have storage.objects.get access'))).toBe(false);
    expect(isGcpNetworkError('No route to host')).toBe(false);
  });
});
