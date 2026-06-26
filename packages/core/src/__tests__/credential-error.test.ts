import { describe, it, expect } from 'vitest';
import { isCredentialError } from '../sync/s3-client.js';

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

  it('does not flag unrelated errors or non-errors', () => {
    expect(isCredentialError(new Error('Access Denied: s3:ListBucket'))).toBe(false);
    expect(isCredentialError(new Error('NetworkError: request timed out'))).toBe(false);
    expect(isCredentialError('a string')).toBe(false);
    expect(isCredentialError(null)).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
  });
});
