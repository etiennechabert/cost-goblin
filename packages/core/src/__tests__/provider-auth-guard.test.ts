import { describe, expect, it } from 'vitest';
import { parseProviderName } from '../config/provider-name.js';
import { isProviderAuth, providerAuth } from '../sync/object-store.js';
import { asBucketPath } from '../types/branded.js';
import type { ProviderConfig } from '../types/config.js';

/** `ProviderAuth` crosses the sync worker's thread boundary as a structured
 *  clone, and the worker re-validates it with `isProviderAuth` before it picks
 *  a credential. A value that passes the guard is used to authenticate, so the
 *  guard must accept every shape `providerAuth` produces and nothing else. */

const daily = { bucket: asBucketPath('s3://billing/focus/'), retentionDays: 365 };

const awsProvider: ProviderConfig = {
  name: parseProviderName('aws-main'),
  type: 'aws',
  credentialsProfile: 'billing-reader',
  sync: { daily, intervalMinutes: 60 },
};

function gcpProvider(extra: { keyFile?: string; impersonateServiceAccount?: string }): ProviderConfig {
  return {
    name: parseProviderName('gcp-main'),
    type: 'gcp',
    ...extra,
    sync: { daily: { bucket: asBucketPath('gs://billing/focus/daily/'), retentionDays: 365 }, intervalMinutes: 60 },
  };
}

describe('isProviderAuth', () => {
  it('accepts what providerAuth produces, after a structured clone', () => {
    const produced = [
      providerAuth(awsProvider),
      providerAuth(gcpProvider({})),
      providerAuth(gcpProvider({ keyFile: '/keys/reader.json' })),
      providerAuth(gcpProvider({ impersonateServiceAccount: 'reader@billing-proj.iam.gserviceaccount.com' })),
    ];
    expect(produced).toEqual([
      { kind: 'aws-profile', profile: 'billing-reader' },
      { kind: 'gcp' },
      { kind: 'gcp', keyFile: '/keys/reader.json' },
      { kind: 'gcp', impersonateServiceAccount: 'reader@billing-proj.iam.gserviceaccount.com' },
    ]);
    for (const auth of produced) {
      expect(isProviderAuth(structuredClone(auth)), JSON.stringify(auth)).toBe(true);
    }
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'gcp'],
    ['a number', 42],
    ['an object without a kind', {}],
    ['an unknown kind', { kind: 'azure', profile: 'default' }],
    ['an AWS auth without a profile', { kind: 'aws-profile' }],
    ['an AWS auth whose profile is not text', { kind: 'aws-profile', profile: 7 }],
    ['a GCP auth whose key file is not text', { kind: 'gcp', keyFile: { path: '/k.json' } }],
    ['a GCP auth whose service account is not text', { kind: 'gcp', impersonateServiceAccount: ['sa@p.iam.gserviceaccount.com'] }],
    ['a GCP auth with a text key file but a bad service account', { kind: 'gcp', keyFile: '/k.json', impersonateServiceAccount: 1 }],
  ])('rejects %s', (_label, value) => {
    expect(isProviderAuth(value)).toBe(false);
  });
});
