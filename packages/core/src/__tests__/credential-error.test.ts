import { describe, it, expect } from 'vitest';
import { isCredentialError, isS3SyncDownloadFailure } from '../sync/s3-client.js';

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
