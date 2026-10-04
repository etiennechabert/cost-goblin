import { describe, expect, it, vi } from 'vitest';
import { adcImpersonationToKeep, gcloudLoginArgs, gcloudLoginEnv } from '../main/gcloud-login.js';
import type { AdcLoginDeps } from '../main/gcloud-login.js';

const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const OTHER_SA = 'company-reader@corp.iam.gserviceaccount.com';
const ADC_PATH = '/Users/a/.config/gcloud/application_default_credentials.json';

/** The legacy `application-default login --impersonate-service-account` file. */
const LEGACY_ADC = JSON.stringify({
  type: 'impersonated_service_account',
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
  delegates: [],
  source_credentials: { type: 'authorized_user', client_id: 'cid', client_secret: 'FAKE-SECRET', refresh_token: 'FAKE-REFRESH' },
});

const PLAIN_ADC = JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'FAKE-SECRET', refresh_token: 'FAKE-REFRESH' });

function deps(adcText: string | undefined, env: Readonly<Record<string, string | undefined>> = { HOME: '/Users/a' }) {
  const readFile = vi.fn((): Promise<string> => (
    adcText === undefined ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) : Promise.resolve(adcText)
  ));
  const loginDeps: AdcLoginDeps = { env, platform: 'darwin', readFile };
  return { ...loginDeps, readFile };
}

describe('gcloudLoginArgs', () => {
  it('signs ADC in as the user, with no impersonation flag, when nothing depends on one', () => {
    expect(gcloudLoginArgs('adc', null)).toEqual(['auth', 'application-default', 'login']);
    expect(gcloudLoginArgs('cli', null)).toEqual(['auth', 'login']);
  });

  it('keeps an impersonation a reader-less provider depends on', () => {
    expect(gcloudLoginArgs('adc', SA)).toEqual(['auth', 'application-default', 'login', `--impersonate-service-account=${SA}`]);
    // The CLI login never impersonates: it is gcloud's own account.
    expect(gcloudLoginArgs('cli', SA)).toEqual(['auth', 'login']);
  });
});

describe('gcloudLoginEnv', () => {
  it('blanks the impersonation property for a plain ADC login, overriding the gcloud config file', () => {
    // gcloud reads auth/impersonate_service_account from flag > env > config
    // file, and an EMPTY env value counts as set — so this beats a
    // `gcloud config set auth/impersonate_service_account …` left behind for
    // CLI work, which would otherwise make ADC an impersonation again.
    const env = gcloudLoginEnv('adc', { HOME: '/home/me', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA }, '/trusted/bin', null);
    expect(env).toEqual({ HOME: '/home/me', PATH: '/trusted/bin', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: '' });
  });

  it('leaves the env alone when keeping an impersonation — the explicit flag wins on its own', () => {
    const env = gcloudLoginEnv('adc', { HOME: '/home/me', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA }, '/trusted/bin', SA);
    expect(env).toEqual({ HOME: '/home/me', PATH: '/trusted/bin', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA });
  });

  it('leaves the CLI login alone, whose impersonation property is the user\'s business', () => {
    const env = gcloudLoginEnv('cli', { HOME: '/home/me', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA }, '/trusted/bin', null);
    expect(env).toEqual({ HOME: '/home/me', PATH: '/trusted/bin', CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA });
  });
});

describe('adcImpersonationToKeep', () => {
  const readerless = {};
  const withReader = { impersonateServiceAccount: OTHER_SA };
  const withKey = { keyFile: '/keys/ci.json' };

  it('keeps the legacy ADC s target while a provider without a reader or key lists through it', async () => {
    const d = deps(LEGACY_ADC);
    expect(await adcImpersonationToKeep(d, [withReader, readerless])).toBe(SA);
    expect(d.readFile).toHaveBeenCalledWith(ADC_PATH);
  });

  it('signs in plainly once every provider names its reader or a key file', async () => {
    expect(await adcImpersonationToKeep(deps(LEGACY_ADC), [withReader, withKey])).toBeNull();
    expect(await adcImpersonationToKeep(deps(LEGACY_ADC), [])).toBeNull();
  });

  it('signs in plainly when ADC is a plain login, missing, or unreadable', async () => {
    expect(await adcImpersonationToKeep(deps(PLAIN_ADC), [readerless])).toBeNull();
    expect(await adcImpersonationToKeep(deps(undefined), [readerless])).toBeNull();
    expect(await adcImpersonationToKeep(deps('not json'), [readerless])).toBeNull();
    expect(await adcImpersonationToKeep(deps(LEGACY_ADC, {}), [readerless])).toBeNull();
  });

  it('reads the file the SDK reads: GOOGLE_APPLICATION_CREDENTIALS first, never a redacted value', async () => {
    const named = deps(LEGACY_ADC, { HOME: '/Users/a', GOOGLE_APPLICATION_CREDENTIALS: '/keys/adc.json' });
    expect(await adcImpersonationToKeep(named, [readerless])).toBe(SA);
    expect(named.readFile).toHaveBeenCalledWith('/keys/adc.json');
    const inline = deps(LEGACY_ADC, { HOME: '/Users/a', GOOGLE_APPLICATION_CREDENTIALS: LEGACY_ADC });
    expect(await adcImpersonationToKeep(inline, [readerless])).toBeNull();
    expect(inline.readFile).not.toHaveBeenCalled();
  });
});
