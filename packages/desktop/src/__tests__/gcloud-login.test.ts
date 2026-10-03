import { describe, expect, it } from 'vitest';
import { gcloudLoginArgs, gcloudLoginEnv } from '../main/gcloud-login.js';

describe('gcloudLoginArgs', () => {
  it('signs ADC in as the user, never with an impersonation flag', () => {
    expect(gcloudLoginArgs('adc')).toEqual(['auth', 'application-default', 'login']);
    expect(gcloudLoginArgs('cli')).toEqual(['auth', 'login']);
  });
});

describe('gcloudLoginEnv', () => {
  it('blanks the impersonation property for the ADC login, overriding the gcloud config file', () => {
    // gcloud reads auth/impersonate_service_account from flag > env > config
    // file, and an EMPTY env value counts as set — so this beats a
    // `gcloud config set auth/impersonate_service_account …` left behind for
    // CLI work, which would otherwise make ADC an impersonation again.
    const env = gcloudLoginEnv('adc', { HOME: '/home/me', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'ops@proj.iam.gserviceaccount.com' }, '/trusted/bin');
    expect(env).toEqual({ HOME: '/home/me', PATH: '/trusted/bin', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '' });
  });

  it('leaves the CLI login alone, whose impersonation property is the user\'s business', () => {
    const env = gcloudLoginEnv('cli', { HOME: '/home/me', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'ops@proj.iam.gserviceaccount.com' }, '/trusted/bin');
    expect(env).toEqual({ HOME: '/home/me', PATH: '/trusted/bin', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'ops@proj.iam.gserviceaccount.com' });
  });
});
