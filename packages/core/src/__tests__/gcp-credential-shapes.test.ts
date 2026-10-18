import { describe, expect, it } from 'vitest';
import { classifyImpersonatedAdc } from '../sync/gcp-adc-classify.js';
import { activeGcloudConfigPath, adcCredentialsLocation, emailFromIdToken, parseAdcJson } from '../sync/gcp-identity.js';

/** Credential shapes the main identity suite does not feed in: an impersonated
 *  ADC file whose service-account source the SDK's JWT path would refuse, a
 *  Windows environment with no %APPDATA%, and an id_token whose payload
 *  segment is not a JSON object. */

const TARGET = 'reader@billing-proj.iam.gserviceaccount.com';

function impersonatedFile(source: Record<string, unknown>): Record<string, unknown> {
  return {
    type: 'impersonated_service_account',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${TARGET}:generateAccessToken`,
    source_credentials: source,
  };
}

describe('classifyImpersonatedAdc with a service-account source', () => {
  it('reads a complete key as the source the reader is minted from', () => {
    const source = { type: 'service_account', client_email: 'ci@billing-proj.iam.gserviceaccount.com', private_key: 'FAKE-KEY' };
    expect(classifyImpersonatedAdc(impersonatedFile(source))).toEqual({
      kind: 'impersonated',
      target: TARGET,
      delegates: [],
      source: { kind: 'service-account', email: 'ci@billing-proj.iam.gserviceaccount.com', record: source },
    });
  });

  it.each([
    ['without its private key', { type: 'service_account', client_email: 'ci@billing-proj.iam.gserviceaccount.com' }],
    ['with an empty private key', { type: 'service_account', client_email: 'ci@billing-proj.iam.gserviceaccount.com', private_key: '' }],
    ['without its client email', { type: 'service_account', private_key: 'FAKE-KEY' }],
  ])('calls a file whose key source is %s unusable, as the SDK would refuse it', (_label, source) => {
    expect(classifyImpersonatedAdc(impersonatedFile(source))).toEqual({ kind: 'unusable' });
  });

  it('keeps a GDCH key off the key path: google-auth-library 11 loads it into its own client', () => {
    const source = { type: 'gdch_service_account', name: 'ci', private_key: 'FAKE-KEY', client_email: 'ci@gdch.example' };
    expect(classifyImpersonatedAdc(impersonatedFile(source))).toMatchObject({ kind: 'impersonated', source: { kind: 'other', type: 'gdch_service_account' } });
    expect(parseAdcJson(source)).toEqual({ kind: 'other', type: 'gdch_service_account' });
  });
});

describe('gcloud locations on Windows without %APPDATA%', () => {
  it('has no well-known ADC file to point at', () => {
    expect(adcCredentialsLocation({}, 'win32')).toBeNull();
    // Set but empty counts as unset.
    expect(adcCredentialsLocation({ APPDATA: '', HOME: String.raw`C:\Users\o` }, 'win32')).toBeNull();
  });

  it('has no active_config record to read', () => {
    expect(activeGcloudConfigPath({}, 'win32')).toBeNull();
    expect(activeGcloudConfigPath({ APPDATA: '', HOME: String.raw`C:\Users\o` }, 'win32')).toBeNull();
  });
});

describe('emailFromIdToken', () => {
  const token = (payload: string): string =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(payload).toString('base64url')}.sig`;

  it('names nobody when the payload segment is not a JSON object', () => {
    expect(emailFromIdToken(token('not json at all'))).toBeNull();
    expect(emailFromIdToken(token('["alice@acme.com"]'))).toBeNull();
    expect(emailFromIdToken(token('"alice@acme.com"'))).toBeNull();
  });

  it('still reads the email claim of a well-formed payload', () => {
    expect(emailFromIdToken(token('{"email":"alice@acme.com","sub":"1"}'))).toBe('alice@acme.com');
  });
});
