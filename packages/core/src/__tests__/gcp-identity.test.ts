import { describe, expect, it, vi } from 'vitest';
import {
  activeGcloudConfigPath,
  activeGcloudConfiguration,
  adcCredentialsLocation,
  classifyAccountLookupError,
  emailFromIdToken,
  grantsEmailScope,
  displayablePath,
  isPathPlaceholder,
  parseAdcJson,
  parseGcloudAccount,
  resolveListingIdentity,
  splitAccounts,
} from '../sync/gcp-identity.js';
import type { AuthorizedUserSecret } from '../sync/gcp-identity.js';
import { adcLoginImpersonationToKeep, impersonationTargetFromUrl } from '../sync/gcp-adc-classify.js';
import type { GcpAccountLookup, GcpCredentialFile, GcpDownloadIdentity, GcpListingIdentity } from '../types/gcp-identity.js';

// ---- Fixture credential files, in the shapes gcloud and the IAM console
// write them. Secrets are obviously fake; the tests also assert none of them
// survive into a resolved identity.

const USER_ADC = {
  client_id: '764086051850-fake.apps.googleusercontent.com',
  client_secret: 'd-FAKE-client-secret',
  refresh_token: '1//FAKE-refresh-token',
  type: 'authorized_user',
  quota_project_id: 'acme-billing',
};

const IMPERSONATED_ADC = {
  delegates: [],
  service_account_impersonation_url:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/costgoblin-reader@acme-billing.iam.gserviceaccount.com:generateAccessToken',
  source_credentials: { ...USER_ADC, account: '' },
  type: 'impersonated_service_account',
};

const SERVICE_ACCOUNT_KEY = {
  type: 'service_account',
  private_key: '-----BEGIN PRIVATE KEY-----FAKE-PRIVATE-KEY-----END PRIVATE KEY-----',
  client_email: 'ci-reader@acme-billing.iam.gserviceaccount.com',
};

/** Single-line markers: `JSON.stringify` escapes a newline, so a marker
 *  containing one could never be found in serialized output. */
const SECRETS = ['d-FAKE-client-secret', '1//FAKE-refresh-token', 'FAKE-PRIVATE-KEY'];

const ADC_FILE: GcpCredentialFile = { path: '/h/.config/gcloud/application_default_credentials.json', origin: 'well-known' };
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const OTHER_SA = 'company-reader@corp.iam.gserviceaccount.com';

function without(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function known(email: string): (secret: AuthorizedUserSecret) => Promise<GcpAccountLookup> {
  return () => Promise.resolve({ status: 'known', email });
}

describe('parseAdcJson', () => {
  it('reads a plain-user ADC file, keeping the refresh secret for the lookup only', () => {
    expect(parseAdcJson(USER_ADC)).toEqual({
      kind: 'user',
      account: null,
      secret: { clientId: USER_ADC.client_id, clientSecret: USER_ADC.client_secret, refreshToken: USER_ADC.refresh_token },
    });
    expect(parseAdcJson(without(USER_ADC, 'refresh_token'))).toEqual({ kind: 'user', account: null, secret: null });
  });

  it('uses an `account` field gcloud wrote, when it is non-empty', () => {
    expect(parseAdcJson({ ...USER_ADC, account: 'alice@acme.com' })).toMatchObject({ kind: 'user', account: 'alice@acme.com' });
  });

  it('reads an impersonated ADC file as its target service account', () => {
    expect(parseAdcJson(IMPERSONATED_ADC)).toEqual({ kind: 'impersonated', target: SA });
    expect(parseAdcJson({ ...IMPERSONATED_ADC, service_account_impersonation_url: 'https://example.com/nope' }))
      .toEqual({ kind: 'other', type: 'impersonated_service_account' });
  });

  it('follows the SDK s JWT fallthrough: any file with client_email and private_key is a key', () => {
    expect(parseAdcJson(SERVICE_ACCOUNT_KEY)).toEqual({ kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email });
    expect(parseAdcJson(without(SERVICE_ACCOUNT_KEY, 'type'))).toEqual({ kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email });
    expect(parseAdcJson(without(SERVICE_ACCOUNT_KEY, 'private_key'))).toEqual({ kind: 'other', type: 'service_account' });
  });

  it('describes federation and unknown types as other, and non-objects as unparseable', () => {
    expect(parseAdcJson({ type: 'external_account', audience: 'x' })).toEqual({ kind: 'other', type: 'external_account' });
    expect(parseAdcJson({ type: 'mystery' })).toEqual({ kind: 'other', type: 'mystery' });
    expect(parseAdcJson(null)).toBeNull();
    expect(parseAdcJson([USER_ADC])).toBeNull();
  });
});

describe('impersonationTargetFromUrl', () => {
  const base = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';

  it('extracts the service account from both IAM credentials verbs', () => {
    expect(impersonationTargetFromUrl(`${base}/sa@p.iam.gserviceaccount.com:generateAccessToken`)).toBe('sa@p.iam.gserviceaccount.com');
    expect(impersonationTargetFromUrl(`${base}/sa@p.iam.gserviceaccount.com:generateIdToken`)).toBe('sa@p.iam.gserviceaccount.com');
  });

  it('rejects a well-formed URL past the SDK s 256-character limit', () => {
    const long = `${base}/${'a'.repeat(200)}@p.iam.gserviceaccount.com:generateAccessToken`;
    expect(long.length).toBeGreaterThan(256);
    // Proves the length guard, not the pattern, is what rejects it.
    expect(/\/serviceAccounts\/[^/]+:generateAccessToken$/.test(long)).toBe(true);
    expect(impersonationTargetFromUrl(long)).toBeNull();
  });

  it('accepts any URL the SDK accepts, so the listing client never refuses a file the SDK loads', () => {
    // google-auth-library's own pattern needs only `<target>:<verb>` at the end.
    expect(impersonationTargetFromUrl('https://iamcredentials.googleapis.com/v1/sa@p.iam.gserviceaccount.com:generateAccessToken')).toBe('sa@p.iam.gserviceaccount.com');
  });

  it('rejects non-strings and unrelated URLs', () => {
    expect(impersonationTargetFromUrl(undefined)).toBeNull();
    expect(impersonationTargetFromUrl('https://example.com/serviceAccounts/x')).toBeNull();
  });
});


describe('ADC and gcloud locations', () => {
  it('never echoes a GOOGLE_APPLICATION_CREDENTIALS value that is not a path', () => {
    const inline = JSON.stringify(SERVICE_ACCOUNT_KEY);
    const location = adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: inline, HOME: '/h' }, 'linux');
    expect(location).toEqual({ path: '<value of GOOGLE_APPLICATION_CREDENTIALS is not a file path>', origin: 'env' });
    expect(isPathPlaceholder(location?.path ?? '')).toBe(true);
    expect(JSON.stringify(location)).not.toContain('PRIVATE KEY');
    expect(displayablePath('/keys/sa.json', 'X')).toBe('/keys/sa.json');
    expect(isPathPlaceholder('/real/path')).toBe(false);
  });

  it('prefers GOOGLE_APPLICATION_CREDENTIALS, as google-auth-library does', () => {
    expect(adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json', HOME: '/home/a' }, 'linux'))
      .toEqual({ path: '/keys/sa.json', origin: 'env' });
    expect(adcCredentialsLocation({ google_application_credentials: '/keys/lower.json' }, 'darwin'))
      .toEqual({ path: '/keys/lower.json', origin: 'env' });
  });

  it('falls back to the well-known file under HOME, or APPDATA on Windows, ignoring CLOUDSDK_CONFIG', () => {
    expect(adcCredentialsLocation({ HOME: '/Users/a', CLOUDSDK_CONFIG: '/elsewhere' }, 'darwin'))
      .toEqual({ path: '/Users/a/.config/gcloud/application_default_credentials.json', origin: 'well-known' });
    expect(adcCredentialsLocation({ APPDATA: String.raw`C:\R` }, 'win32'))
      .toEqual({ path: String.raw`C:\R\gcloud\application_default_credentials.json`, origin: 'well-known' });
    expect(adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: '', HOME: '/h' }, 'linux')?.origin).toBe('well-known');
    expect(adcCredentialsLocation({}, 'linux')).toBeNull();
  });

  it('finds gcloud s active configuration where gcloud does', () => {
    expect(activeGcloudConfigPath({ HOME: '/h' }, 'darwin')).toBe('/h/.config/gcloud/active_config');
    expect(activeGcloudConfigPath({ HOME: '/h', CLOUDSDK_CONFIG: '/work' }, 'linux')).toBe('/work/active_config');
    expect(activeGcloudConfigPath({ APPDATA: String.raw`C:\R` }, 'win32')).toBe(String.raw`C:\R\gcloud\active_config`);
    expect(activeGcloudConfigPath({}, 'darwin')).toBeNull();
    expect(activeGcloudConfiguration({}, 'acme-admin\n')).toBe('acme-admin');
    expect(activeGcloudConfiguration({ CLOUDSDK_ACTIVE_CONFIG_NAME: 'ci' }, 'acme-admin')).toBe('ci');
    expect(activeGcloudConfiguration({}, null)).toBe('default');
  });

  it('reads gcloud s account from `config list --format=json`', () => {
    expect(parseGcloudAccount(JSON.stringify({ core: { account: 'alice@acme.com', project: 'p' } }))).toBe('alice@acme.com');
    expect(parseGcloudAccount(JSON.stringify({ core: { project: 'p' } }))).toBeNull();
    expect(parseGcloudAccount('{}')).toBeNull();
    expect(parseGcloudAccount('Updates are available')).toBeUndefined();
  });
});

describe('resolveListingIdentity', () => {
  it('names a plain user through the lookup, or from the file when it says', async () => {
    const lookup = vi.fn(known('alice@acme.com'));
    expect(await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, lookup))
      .toEqual({ kind: 'user', file: ADC_FILE, account: { status: 'known', email: 'alice@acme.com' } });
    expect(lookup).toHaveBeenCalledWith({ clientId: USER_ADC.client_id, clientSecret: USER_ADC.client_secret, refreshToken: USER_ADC.refresh_token });
    lookup.mockClear();
    await resolveListingIdentity(parseAdcJson({ ...USER_ADC, account: 'bob@acme.com' }), ADC_FILE, lookup);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('classifies a failed lookup instead of rejecting — whatever the error carries', async () => {
    const expired = await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, () => Promise.reject(new Error('invalid_grant')));
    expect(expired).toMatchObject({ account: { status: 'unknown', reason: 'expired' } });
    // google-auth-library copies a non-JSON-error body into `message` verbatim.
    const weird = Object.assign(new Error('x'), { message: { code: 403 } });
    const unreachable = await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, () => Promise.reject(weird));
    expect(unreachable).toMatchObject({ account: { status: 'unknown', reason: 'unreachable' } });
    const noToken = await resolveListingIdentity(parseAdcJson(without(USER_ADC, 'refresh_token')), ADC_FILE, known('x'));
    expect(noToken).toMatchObject({ account: { status: 'unknown', reason: 'expired' } });
  });

  it('describes impersonated, service-account, other and unparseable files without calling out', async () => {
    const lookup = vi.fn(known('unused@x.com'));
    expect(await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), ADC_FILE, lookup)).toEqual({ kind: 'impersonated', file: ADC_FILE, target: SA });
    expect(await resolveListingIdentity(parseAdcJson(SERVICE_ACCOUNT_KEY), ADC_FILE, lookup))
      .toEqual({ kind: 'service-account', file: ADC_FILE, email: SERVICE_ACCOUNT_KEY.client_email });
    expect(await resolveListingIdentity(parseAdcJson({ type: 'mystery' }), ADC_FILE, lookup)).toEqual({ kind: 'other', file: ADC_FILE, type: 'mystery' });
    expect(await resolveListingIdentity(null, ADC_FILE, lookup)).toEqual({ kind: 'unreadable', file: ADC_FILE });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('never lets a secret reach the resolved identity', async () => {
    for (const fixture of [USER_ADC, IMPERSONATED_ADC, SERVICE_ACCOUNT_KEY]) {
      const serialized = JSON.stringify(await resolveListingIdentity(parseAdcJson(fixture), ADC_FILE, known('alice@acme.com')));
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    }
  });
});

describe('emailFromIdToken / classifyAccountLookupError / grantsEmailScope', () => {
  const jwt = (payload: unknown): string => {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
  };

  it('reads the email claim of an id_token', () => {
    expect(emailFromIdToken(jwt({ email: 'alice@acme.com' }))).toBe('alice@acme.com');
    expect(emailFromIdToken(jwt({ sub: '123' }))).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
  });

  it('tells a dead sign-in from an unreachable Google', () => {
    expect(classifyAccountLookupError(new Error('invalid_rapt: reauth related error'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('unauthorized_client'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'))).toBe('unreachable');
    expect(classifyAccountLookupError('weird')).toBe('unreachable');
  });

  it('knows which granted scopes can name the account', () => {
    expect(grantsEmailScope('https://www.googleapis.com/auth/cloud-platform')).toBe(false);
    expect(grantsEmailScope('openid https://www.googleapis.com/auth/userinfo.email')).toBe(true);
    expect(grantsEmailScope(undefined)).toBeNull();
  });
});

describe('splitAccounts', () => {
  const alice: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: { status: 'known', email: 'alice@acme.com' } };
  const gcloud = (account: string | null): GcpDownloadIdentity => ({ kind: 'gcloud', account, configuration: 'default' });

  it('flags gcloud running as a different person than ADC', () => {
    expect(splitAccounts(alice, gcloud('admin@acme.com'))).toEqual({ listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' });
  });

  it('is quiet when they agree, case aside', () => {
    expect(splitAccounts(alice, gcloud('ALICE@acme.com'))).toBeNull();
  });

  it('cannot compare what it cannot name, and leaves service accounts to the provider', () => {
    const unknown: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: { status: 'unknown', reason: 'unreachable' } };
    expect(splitAccounts(unknown, gcloud('admin@acme.com'))).toBeNull();
    expect(splitAccounts(alice, gcloud(null))).toBeNull();
    expect(splitAccounts(alice, { kind: 'cli-missing' })).toBeNull();
    expect(splitAccounts({ kind: 'impersonated', file: ADC_FILE, target: SA }, gcloud('admin@acme.com'))).toBeNull();
    expect(splitAccounts({ kind: 'service-account', file: ADC_FILE, email: 'ci@x.iam.gserviceaccount.com' }, gcloud('admin@acme.com'))).toBeNull();
  });
});

describe('adcLoginImpersonationToKeep', () => {
  const readerless = {};
  const withReader = { impersonateServiceAccount: SA };
  const withKey = { keyFile: '/keys/ci.json' };

  it('keeps a legacy ADC s impersonation while a provider without a reader or key lists through it', () => {
    expect(adcLoginImpersonationToKeep(IMPERSONATED_ADC, [withReader, readerless])).toBe(SA);
  });

  it('signs in plainly once every provider names its reader or a key', () => {
    expect(adcLoginImpersonationToKeep(IMPERSONATED_ADC, [withReader, withKey])).toBeNull();
    expect(adcLoginImpersonationToKeep(IMPERSONATED_ADC, [])).toBeNull();
  });

  it('signs in plainly when ADC impersonates nothing, or is unusable anyway', () => {
    expect(adcLoginImpersonationToKeep(USER_ADC, [readerless])).toBeNull();
    expect(adcLoginImpersonationToKeep(null, [readerless])).toBeNull();
    expect(adcLoginImpersonationToKeep(without(IMPERSONATED_ADC, 'source_credentials'), [readerless])).toBeNull();
  });

  it('keeps Google-managed default service accounts too, which a provider cannot name as its reader', () => {
    // Falling back to a plain sign-in here would widen the provider to the
    // user's own access — the very thing keeping the impersonation prevents.
    for (const managed of ['123456789012-compute@developer.gserviceaccount.com', 'my-app@appspot.gserviceaccount.com']) {
      const adc = {
        ...IMPERSONATED_ADC,
        service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${managed}:generateAccessToken`,
      };
      expect(adcLoginImpersonationToKeep(adc, [readerless]), managed).toBe(managed);
    }
  });

  it('keeps a delegation chain whole, and passes only well-formed service-account addresses to argv', () => {
    expect(adcLoginImpersonationToKeep({ ...IMPERSONATED_ADC, delegates: [OTHER_SA] }, [readerless])).toBe(`${OTHER_SA},${SA}`);
    expect(adcLoginImpersonationToKeep({ ...IMPERSONATED_ADC, delegates: ['--format=json'] }, [readerless])).toBeNull();
    const odd = {
      ...IMPERSONATED_ADC,
      service_account_impersonation_url: 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/a b&c:generateAccessToken',
    };
    expect(adcLoginImpersonationToKeep(odd, [readerless])).toBeNull();
  });
});
