import { describe, it, expect } from 'vitest';
import { isCredentialError, isS3SyncDownloadFailure } from '../sync/s3-client.js';
import { isGcloudCliAccountError, isGcloudDownloadFailure, isGcpCredentialError } from '../sync/gcs-client.js';

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

describe('isGcloudDownloadFailure', () => {
  it('detects opaque gcloud retry / connection download failures', () => {
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): Max retries exceeded'))).toBe(true);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): Connection reset by peer'))).toBe(true);
    expect(isGcloudDownloadFailure(new Error('gcloud storage rsync failed (exit 1): ServiceUnavailable'))).toBe(true);
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
