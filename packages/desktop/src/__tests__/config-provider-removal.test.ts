import { describe, expect, it } from 'vitest';
import { removeProviderEntry, swapProviderCredentialsProfile } from '../main/config-upsert.js';

/** removeProviderEntry (the "Remove provider" flow) and the provider-entry
 *  name matching both config transforms share, including entries a hand edit
 *  left malformed. */

const awsMain = { name: 'aws-main', type: 'aws', credentialsProfile: 'main', sync: { daily: { bucket: 's3://a/daily/', retentionDays: 365 } } };
const awsPayer = { name: 'aws-payer', type: 'aws', credentialsProfile: 'payer', sync: { daily: { bucket: 's3://b/daily/', retentionDays: 365 } } };
const gcp = { name: 'gcp-main', type: 'gcp', sync: { daily: { bucket: 'gs://c/focus/', retentionDays: 365 } } };

describe('removeProviderEntry', () => {
  it('removes exactly the named provider, keeping the other entries and every other key', () => {
    const existing = { defaults: { periodDays: 30 }, providers: [awsMain, awsPayer, gcp], unknownKey: 'kept' };

    const result = removeProviderEntry(existing, 'aws-payer');

    expect(result).toEqual({ defaults: { periodDays: 30 }, providers: [awsMain, gcp], unknownKey: 'kept' });
    expect(existing.providers).toHaveLength(3);
  });

  it('refuses a name that is not configured, including when there is no providers list', () => {
    expect(() => removeProviderEntry({ providers: [awsMain, awsPayer] }, 'AWS-MAIN')).toThrow('Unknown provider "AWS-MAIN"');
    expect(() => removeProviderEntry({}, 'aws-main')).toThrow('Unknown provider "aws-main"');
    expect(() => removeProviderEntry({ providers: 'aws-main' }, 'aws-main')).toThrow('Unknown provider "aws-main"');
  });

  it('refuses to remove the last remaining provider', () => {
    expect(() => removeProviderEntry({ providers: [gcp] }, 'gcp-main'))
      .toThrow('Cannot remove the last provider — the app needs at least one billing source.');
  });

  it('matches by name past entries a hand edit left malformed, keeping them untouched', () => {
    const junk = 'not a provider';
    const numericName = { name: 42, type: 'aws' };

    const result = removeProviderEntry({ providers: [junk, numericName, awsMain, awsPayer] }, 'aws-main');

    expect(result['providers']).toEqual([junk, numericName, awsPayer]);
  });
});

describe('swapProviderCredentialsProfile on unnamed or malformed entries', () => {
  it('names a nameless GCP first provider as "" when refusing to give it an AWS profile', () => {
    expect(() => swapProviderCredentialsProfile({ providers: [{ type: 'gcp' }] }, 'billing'))
      .toThrow('Provider "" is a GCP provider');
  });

  it('finds the named provider past malformed entries', () => {
    const result = swapProviderCredentialsProfile({ providers: ['junk', { name: 7 }, awsPayer] }, 'billing-v2', 'aws-payer');

    expect(result['providers']).toEqual(['junk', { name: 7 }, { ...awsPayer, credentialsProfile: 'billing-v2' }]);
  });
});
