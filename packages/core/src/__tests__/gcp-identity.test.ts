import { describe, expect, it, vi } from 'vitest';
import {
  activeGcloudConfigPath,
  activeGcloudConfiguration,
  adcCredentialsLocation,
  adcLoginPath,
  assembleDownloadIdentity,
  classifyAccountLookupError,
  credentialEmail,
  emailFromIdToken,
  gcloudConfigDir,
  gcpIdentityNotes,
  gcpIdentityWarnings,
  grantsEmailScope,
  impersonationTargetFromUrl,
  parseAdcJson,
  parseGcloudConfigList,
  resolveListingIdentity,
} from '../sync/gcp-identity.js';
import type { AuthorizedUserSecret, GcloudConfigValues } from '../sync/gcp-identity.js';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpListingIdentity,
} from '../types/gcp-identity.js';

// ---- Fixture credential files, in the shapes gcloud and the IAM console
// write them. Secrets are obviously fake; the tests also assert none of them
// survive into a resolved identity.

const USER_ADC = {
  client_id: '764086051850-fake.apps.googleusercontent.com',
  client_secret: 'd-FAKE-client-secret',
  refresh_token: '1//FAKE-refresh-token',
  type: 'authorized_user',
  quota_project_id: 'acme-billing',
  universe_domain: 'googleapis.com',
};

const IMPERSONATED_ADC = {
  delegates: [],
  service_account_impersonation_url:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/costgoblin-reader@acme-billing.iam.gserviceaccount.com:generateAccessToken',
  source_credentials: {
    account: '',
    client_id: '764086051850-fake.apps.googleusercontent.com',
    client_secret: 'd-FAKE-client-secret',
    refresh_token: '1//FAKE-refresh-token',
    type: 'authorized_user',
    universe_domain: 'googleapis.com',
  },
  type: 'impersonated_service_account',
};

const SERVICE_ACCOUNT_KEY = {
  type: 'service_account',
  project_id: 'acme-billing',
  private_key_id: 'abc123',
  private_key: '-----BEGIN PRIVATE KEY-----FAKE-PRIVATE-KEY-----END PRIVATE KEY-----',
  client_email: 'ci-reader@acme-billing.iam.gserviceaccount.com',
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const EXTERNAL_ADC = {
  type: 'external_account',
  audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/gh',
  subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
  token_url: 'https://sts.googleapis.com/v1/token',
  service_account_impersonation_url:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/wif-reader@acme-billing.iam.gserviceaccount.com:generateAccessToken',
  credential_source: { file: '/var/run/token' },
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
  });

  it('uses an `account` field gcloud wrote, when it is non-empty', () => {
    const parsed = parseAdcJson({ ...USER_ADC, account: 'Alice@Acme.com' });
    expect(parsed?.kind === 'user' ? parsed.account : 'wrong-kind').toBe('Alice@Acme.com');
  });

  it('reads an impersonated ADC file: user source plus target service account', () => {
    const parsed = parseAdcJson(IMPERSONATED_ADC);
    expect(parsed?.kind).toBe('impersonated');
    if (parsed?.kind !== 'impersonated') return;
    expect(parsed.target).toBe(SA);
    // The empty `account` gcloud writes is treated as absent, not as an email.
    expect(parsed.source).toMatchObject({ kind: 'user', account: null });
  });

  it('reads an impersonated ADC whose source is a service-account key', () => {
    expect(parseAdcJson({ ...IMPERSONATED_ADC, source_credentials: SERVICE_ACCOUNT_KEY })).toEqual({
      kind: 'impersonated',
      target: SA,
      source: { kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email },
    });
  });

  it('reads a service-account key used as ADC', () => {
    expect(parseAdcJson(SERVICE_ACCOUNT_KEY)).toEqual({ kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email });
  });

  it('follows the SDK s JWT fallthrough: any file with client_email and private_key is a key', () => {
    expect(parseAdcJson(without(SERVICE_ACCOUNT_KEY, 'type'))).toEqual({ kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email });
    expect(parseAdcJson({ ...SERVICE_ACCOUNT_KEY, type: 'gdch_service_account' }))
      .toEqual({ kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email });
    // ...and without a private key the SDK rejects it.
    expect(parseAdcJson(without(SERVICE_ACCOUNT_KEY, 'private_key'))).toEqual({ kind: 'unrecognized', type: 'service_account' });
  });

  it('reads workload and workforce identity federation', () => {
    expect(parseAdcJson(EXTERNAL_ADC)).toEqual({ kind: 'external', target: 'wif-reader@acme-billing.iam.gserviceaccount.com' });
    expect(parseAdcJson(without(EXTERNAL_ADC, 'service_account_impersonation_url'))).toEqual({ kind: 'external', target: null });
    expect(parseAdcJson({ type: 'external_account_authorized_user', audience: 'x' })).toEqual({ kind: 'external', target: null });
  });

  it('marks what the SDK would reject as unrecognized', () => {
    expect(parseAdcJson({ type: 'mystery' })).toEqual({ kind: 'unrecognized', type: 'mystery' });
    expect(parseAdcJson({})).toEqual({ kind: 'unrecognized', type: null });
    expect(parseAdcJson({ ...IMPERSONATED_ADC, service_account_impersonation_url: 'https://example.com/nope' }))
      .toEqual({ kind: 'unrecognized', type: 'impersonated_service_account' });
  });

  it('returns null for anything that is not a JSON object', () => {
    expect(parseAdcJson(null)).toBeNull();
    expect(parseAdcJson('authorized_user')).toBeNull();
    expect(parseAdcJson([USER_ADC])).toBeNull();
  });

  it('gives a user ADC with no refresh token no secret to look up', () => {
    expect(parseAdcJson(without(USER_ADC, 'refresh_token'))).toEqual({ kind: 'user', account: null, secret: null });
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

  it('rejects non-strings and unrelated URLs', () => {
    expect(impersonationTargetFromUrl(undefined)).toBeNull();
    expect(impersonationTargetFromUrl('https://example.com/serviceAccounts/x')).toBeNull();
  });
});

describe('ADC and gcloud locations', () => {
  it('prefers GOOGLE_APPLICATION_CREDENTIALS, as google-auth-library does', () => {
    expect(adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json', HOME: '/home/a' }, 'linux'))
      .toEqual({ path: '/keys/sa.json', origin: 'env' });
    expect(adcCredentialsLocation({ google_application_credentials: '/keys/lower.json' }, 'darwin'))
      .toEqual({ path: '/keys/lower.json', origin: 'env' });
  });

  it('falls back to the well-known file under HOME, or APPDATA on Windows', () => {
    expect(adcCredentialsLocation({ HOME: '/Users/a' }, 'darwin'))
      .toEqual({ path: '/Users/a/.config/gcloud/application_default_credentials.json', origin: 'well-known' });
    expect(adcCredentialsLocation({ APPDATA: String.raw`C:\Users\a\AppData\Roaming` }, 'win32'))
      .toEqual({ path: String.raw`C:\Users\a\AppData\Roaming\gcloud\application_default_credentials.json`, origin: 'well-known' });
  });

  it('treats empty variables as unset and reports no location when none apply', () => {
    expect(adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: '', HOME: '/h' }, 'linux')?.origin).toBe('well-known');
    expect(adcCredentialsLocation({}, 'linux')).toBeNull();
    expect(adcCredentialsLocation({ HOME: '/h' }, 'win32')).toBeNull();
  });

  it('puts gcloud s config dir where gcloud does, CLOUDSDK_CONFIG first', () => {
    expect(gcloudConfigDir({ HOME: '/h' }, 'linux')).toBe('/h/.config/gcloud');
    expect(gcloudConfigDir({ HOME: '/h', CLOUDSDK_CONFIG: '/work/gcloud' }, 'linux')).toBe('/work/gcloud');
    expect(gcloudConfigDir({ APPDATA: String.raw`C:\R` }, 'win32')).toBe(String.raw`C:\R\gcloud`);
    expect(activeGcloudConfigPath({ HOME: '/h' }, 'darwin')).toBe('/h/.config/gcloud/active_config');
    expect(activeGcloudConfigPath({}, 'darwin')).toBeNull();
  });

  it('reports where an ADC sign-in would land when CLOUDSDK_CONFIG moves it away from what the SDK reads', () => {
    expect(adcLoginPath({ HOME: '/h' }, 'linux')).toBeNull();
    expect(adcLoginPath({ HOME: '/h', CLOUDSDK_CONFIG: '/h/.config/gcloud' }, 'linux')).toBeNull();
    expect(adcLoginPath({ HOME: '/h', CLOUDSDK_CONFIG: '/work/gcloud' }, 'linux')).toBe('/work/gcloud/application_default_credentials.json');
    // Same directory, different case: the same place on macOS and Windows.
    expect(adcLoginPath({ HOME: '/Users/a', CLOUDSDK_CONFIG: '/users/a/.config/gcloud' }, 'darwin')).toBeNull();
    // GOOGLE_APPLICATION_CREDENTIALS has its own remedy: the variable.
    expect(adcLoginPath({ HOME: '/h', CLOUDSDK_CONFIG: '/work', GOOGLE_APPLICATION_CREDENTIALS: '/k.json' }, 'linux')).toBeNull();
  });
});

describe('resolveListingIdentity', () => {
  it('names a plain user through the lookup', async () => {
    const lookup = vi.fn(known('alice@acme.com'));
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, lookup);
    expect(identity).toEqual({ kind: 'user', file: ADC_FILE, account: { status: 'known', email: 'alice@acme.com' } });
    expect(lookup).toHaveBeenCalledWith({ clientId: USER_ADC.client_id, clientSecret: USER_ADC.client_secret, refreshToken: USER_ADC.refresh_token });
  });

  it('skips the network when the file already names the account', async () => {
    const lookup = vi.fn(known('never@used.com'));
    const identity = await resolveListingIdentity(parseAdcJson({ ...USER_ADC, account: 'alice@acme.com' }), ADC_FILE, lookup);
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'known', email: 'alice@acme.com' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('names the human behind an impersonated credential, and its target', async () => {
    expect(await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), ADC_FILE, known('alice@acme.com'))).toEqual({
      kind: 'impersonated',
      file: ADC_FILE,
      target: SA,
      source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } },
    });
  });

  it('carries a failed lookup through as a classified reason', async () => {
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, () => Promise.resolve({ status: 'unknown', reason: 'not-recorded' }));
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'not-recorded' } });
  });

  it('turns a throwing lookup into an unknown account rather than rejecting', async () => {
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, () => Promise.reject(new Error('invalid_grant: Token has been expired or revoked.')));
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'expired' } });
  });

  it('survives an error whose message is not a string', async () => {
    // google-auth-library copies a non-JSON-error response body into
    // `message` verbatim — an object, or null.
    const weird = Object.assign(new Error('x'), { message: { code: 403, msg: 'blocked' } });
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, () => Promise.reject(weird));
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'unreachable' } });
  });

  it('reports a user credential with no refresh token as un-nameable without calling out', async () => {
    const lookup = vi.fn(known('x@y.z'));
    const identity = await resolveListingIdentity(parseAdcJson(without(USER_ADC, 'refresh_token')), ADC_FILE, lookup);
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'expired' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('describes service-account, external, unrecognized and unparseable files', async () => {
    const lookup = known('unused@x.com');
    expect(await resolveListingIdentity(parseAdcJson(SERVICE_ACCOUNT_KEY), ADC_FILE, lookup))
      .toEqual({ kind: 'service-account', file: ADC_FILE, email: SERVICE_ACCOUNT_KEY.client_email });
    expect(await resolveListingIdentity(parseAdcJson(EXTERNAL_ADC), ADC_FILE, lookup))
      .toEqual({ kind: 'external', file: ADC_FILE, target: 'wif-reader@acme-billing.iam.gserviceaccount.com' });
    expect(await resolveListingIdentity(parseAdcJson({ type: 'mystery' }), ADC_FILE, lookup))
      .toEqual({ kind: 'unrecognized', file: ADC_FILE, type: 'mystery' });
    expect(await resolveListingIdentity(null, ADC_FILE, lookup)).toEqual({ kind: 'unreadable', file: ADC_FILE });
  });

  it('never lets a secret reach the resolved identity', async () => {
    const fixtures: unknown[] = [USER_ADC, IMPERSONATED_ADC, SERVICE_ACCOUNT_KEY, EXTERNAL_ADC, { ...IMPERSONATED_ADC, source_credentials: SERVICE_ACCOUNT_KEY }];
    for (const fixture of fixtures) {
      const serialized = JSON.stringify(await resolveListingIdentity(parseAdcJson(fixture), ADC_FILE, known('alice@acme.com')));
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    }
  });

  it('names the email a credential authenticates as, when it can', async () => {
    expect(credentialEmail(await resolveListingIdentity(parseAdcJson(SERVICE_ACCOUNT_KEY), ADC_FILE, known('x')))).toBe(SERVICE_ACCOUNT_KEY.client_email);
    expect(credentialEmail(await resolveListingIdentity(parseAdcJson(USER_ADC), ADC_FILE, known('alice@acme.com')))).toBe('alice@acme.com');
    expect(credentialEmail(await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), ADC_FILE, known('alice@acme.com')))).toBeNull();
  });
});

describe('emailFromIdToken', () => {
  function jwt(payload: unknown): string {
    const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
  }

  it('reads the email claim', () => {
    expect(emailFromIdToken(jwt({ email: 'alice@acme.com', email_verified: true }))).toBe('alice@acme.com');
  });

  it('returns null for a token without an email or that is not a JWT', () => {
    expect(emailFromIdToken(jwt({ sub: '123' }))).toBeNull();
    expect(emailFromIdToken('not-a-jwt')).toBeNull();
    expect(emailFromIdToken('a.!!!.c')).toBeNull();
  });
});

describe('classifyAccountLookupError / grantsEmailScope', () => {
  it('recognises an expired, revoked or disallowed sign-in', () => {
    expect(classifyAccountLookupError(new Error('invalid_grant'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('invalid_rapt: reauth related error'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('Token has been expired or revoked.'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('unauthorized_client'))).toBe('expired');
  });

  it('reports anything else as unreachable, whatever the message holds', () => {
    expect(classifyAccountLookupError(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'))).toBe('unreachable');
    expect(classifyAccountLookupError('weird')).toBe('unreachable');
    expect(classifyAccountLookupError(Object.assign(new Error(''), { message: null }))).toBe('unreachable');
  });

  it('knows which granted scopes can name the account', () => {
    expect(grantsEmailScope('https://www.googleapis.com/auth/cloud-platform')).toBe(false);
    expect(grantsEmailScope('openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform')).toBe(true);
    expect(grantsEmailScope(undefined)).toBeNull();
  });
});

describe('gcloud configuration', () => {
  it('reads the credential-relevant properties of `gcloud config list --format=json`', () => {
    const stdout = JSON.stringify({
      core: { account: 'alice@acme.com', project: 'acme', disable_usage_reporting: 'True' },
      auth: { impersonate_service_account: 'hop@p.iam.gserviceaccount.com, ops@corp.iam.gserviceaccount.com', credential_file_override: '/k.json', access_token_file: '/t' },
    });
    expect(parseGcloudConfigList(stdout)).toEqual({
      account: 'alice@acme.com',
      // A delegation chain impersonates its LAST account.
      impersonateServiceAccount: 'ops@corp.iam.gserviceaccount.com',
      credentialFileOverride: '/k.json',
      accessTokenFile: '/t',
    });
  });

  it('treats absent sections as unset, and non-JSON as unreadable', () => {
    expect(parseGcloudConfigList('{}')).toEqual({ account: null, impersonateServiceAccount: null, credentialFileOverride: null, accessTokenFile: null });
    expect(parseGcloudConfigList('Updates are available')).toBeNull();
  });

  it('names the active configuration the way gcloud resolves it', () => {
    expect(activeGcloudConfiguration({}, 'acme-admin\n')).toBe('acme-admin');
    expect(activeGcloudConfiguration({ CLOUDSDK_ACTIVE_CONFIG_NAME: 'ci' }, 'acme-admin')).toBe('ci');
    expect(activeGcloudConfiguration({}, null)).toBe('default');
    expect(activeGcloudConfiguration({}, '  \n')).toBe('default');
  });
});

describe('assembleDownloadIdentity', () => {
  const CONFIG: GcloudConfigValues = { account: 'alice@acme.com', impersonateServiceAccount: null, credentialFileOverride: null, accessTokenFile: null };
  const base = { config: CONFIG, configuration: 'default', accountFromEnv: false, providerKeyFile: null, providerTarget: null, overrideFileEmail: null };
  const keyFile = { path: '/keys/ci.json', email: 'ci@x.iam.gserviceaccount.com' };

  it('runs as the active account by default', () => {
    expect(assembleDownloadIdentity(base)).toEqual({
      kind: 'gcloud',
      principal: { kind: 'account', account: 'alice@acme.com', fromEnv: false },
      impersonate: null,
      configuration: 'default',
    });
  });

  it('lets the provider s impersonation win over gcloud s own', () => {
    const config = { ...CONFIG, impersonateServiceAccount: OTHER_SA };
    expect(assembleDownloadIdentity({ ...base, config })).toMatchObject({ impersonate: { target: OTHER_SA, origin: 'gcloud-config' } });
    expect(assembleDownloadIdentity({ ...base, config, providerTarget: SA })).toMatchObject({ impersonate: { target: SA, origin: 'provider' } });
  });

  it('follows gcloud s credential precedence: token file, then key file, then account', () => {
    expect(assembleDownloadIdentity({ ...base, providerKeyFile: keyFile }))
      .toMatchObject({ principal: { kind: 'key-file', path: '/keys/ci.json', origin: 'provider', email: 'ci@x.iam.gserviceaccount.com' } });
    expect(assembleDownloadIdentity({ ...base, config: { ...CONFIG, credentialFileOverride: '/g.json' }, overrideFileEmail: 'g@x.iam.gserviceaccount.com' }))
      .toMatchObject({ principal: { kind: 'key-file', path: '/g.json', origin: 'gcloud-config', email: 'g@x.iam.gserviceaccount.com' } });
    // The provider's key is passed as the env override, beating gcloud's.
    expect(assembleDownloadIdentity({ ...base, config: { ...CONFIG, credentialFileOverride: '/g.json' }, providerKeyFile: keyFile }))
      .toMatchObject({ principal: { kind: 'key-file', origin: 'provider' } });
    // auth/access_token_file outranks everything, the key file included.
    expect(assembleDownloadIdentity({ ...base, config: { ...CONFIG, accessTokenFile: '/t' }, providerKeyFile: keyFile }))
      .toMatchObject({ principal: { kind: 'access-token-file', path: '/t' } });
  });
});

describe('gcpIdentityWarnings / gcpIdentityNotes', () => {
  const alice: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };
  const unrecorded: GcpAccountLookup = { status: 'unknown', reason: 'not-recorded' };

  const impersonatedAs = (target: string, account: GcpAccountLookup = alice): GcpListingIdentity => ({
    kind: 'impersonated', file: ADC_FILE, target, source: { kind: 'user', account },
  });
  const plainUser: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: alice };
  const gcloud = (principal: GcpDownloadPrincipal, impersonate: GcpDownloadImpersonation | null = null): GcpDownloadIdentity => (
    { kind: 'gcloud', principal, impersonate, configuration: 'default' }
  );
  const account = (email: string | null, fromEnv = false): GcpDownloadPrincipal => ({ kind: 'account', account: email, fromEnv });
  const viaProvider = (target: string): GcpDownloadImpersonation => ({ target, origin: 'provider' });
  const viaGcloud = (target: string): GcpDownloadImpersonation => ({ target, origin: 'gcloud-config' });
  const keyListing: GcpListingIdentity = { kind: 'service-account', file: { path: '/k.json', origin: 'key-file' }, email: 'ci@x.iam.gserviceaccount.com' };
  const keyPrincipal: GcpDownloadPrincipal = { kind: 'key-file', path: '/k.json', origin: 'provider', email: 'ci@x.iam.gserviceaccount.com' };

  it('is quiet when both paths agree', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA), gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com')))).toEqual([]);
  });

  it('compares accounts and targets case-insensitively', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA.toUpperCase()), gcloud(account('ALICE@acme.com'), viaProvider(SA)))).toEqual([]);
  });

  it('flags listing and downloads impersonating different service accounts', () => {
    expect(gcpIdentityWarnings(impersonatedAs(OTHER_SA), gcloud(account('alice@acme.com'), viaProvider(SA))))
      .toEqual([{ kind: 'target-mismatch', listingTarget: OTHER_SA, download: viaProvider(SA) }]);
    expect(gcpIdentityWarnings(impersonatedAs(SA), gcloud(account('alice@acme.com'), viaGcloud(OTHER_SA))))
      .toEqual([{ kind: 'target-mismatch', listingTarget: SA, download: viaGcloud(OTHER_SA) }]);
  });

  it('flags downloads that impersonate when listing does not', () => {
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com'), viaProvider(SA))))
      .toEqual([{ kind: 'listing-not-impersonated', download: viaProvider(SA) }]);
    // A key-file provider still downloads through gcloud, which applies its own impersonation setting.
    expect(gcpIdentityWarnings(keyListing, gcloud(keyPrincipal, viaGcloud(OTHER_SA))))
      .toEqual([{ kind: 'listing-not-impersonated', download: viaGcloud(OTHER_SA) }]);
  });

  it('flags listing that impersonates when downloads do not — the wizard-created provider', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA), gcloud(account('alice@acme.com'))))
      .toEqual([{ kind: 'download-not-impersonated', listingTarget: SA }]);
  });

  it('flags gcloud running as a different principal than listing, with what it needs to fix it', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA), gcloud(account('admin@acme.com', true), viaProvider(SA)))).toEqual([{
      kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadAccountFromEnv: true,
    }]);
    const saAdc: GcpListingIdentity = { kind: 'service-account', file: { path: '/keys/ci.json', origin: 'env' }, email: 'ci@x.iam.gserviceaccount.com' };
    expect(gcpIdentityWarnings(saAdc, gcloud(account('alice@acme.com')))).toEqual([{
      kind: 'split-accounts', listingAccount: 'ci@x.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: '/keys/ci.json', downloadAccountFromEnv: false,
    }]);
  });

  it('reports every mismatch at once, targets first', () => {
    expect(gcpIdentityWarnings(impersonatedAs(OTHER_SA, { status: 'known', email: 'bob@corp.com' }), gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([
      { kind: 'target-mismatch', listingTarget: OTHER_SA, download: viaProvider(SA) },
      { kind: 'split-accounts', listingAccount: 'bob@corp.com', downloadAccount: 'alice@acme.com', listingKeyFile: null, downloadAccountFromEnv: false },
    ]);
  });

  it('cannot compare what it cannot name', () => {
    const unknownUser: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: { status: 'unknown', reason: 'unreachable' } };
    expect(gcpIdentityWarnings(unknownUser, gcloud(account('admin@acme.com')))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud(account(null)))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud({ kind: 'access-token-file', path: '/t' }))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, { kind: 'cli-missing' })).toEqual([]);
  });

  it('says nothing about impersonation when ADC is missing — the panel already reports that', () => {
    expect(gcpIdentityWarnings({ kind: 'not-signed-in', file: ADC_FILE }, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
    expect(gcpIdentityWarnings({ kind: 'unreadable', file: ADC_FILE }, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
  });

  it('is quiet for a key-file provider whose downloads use the same key', () => {
    expect(gcpIdentityWarnings(keyListing, gcloud(keyPrincipal))).toEqual([]);
  });

  it('asks the user to compare when an impersonated sign-in does not name its human, naming what downloads impersonate', () => {
    const listing = impersonatedAs(SA, unrecorded);
    expect(gcpIdentityWarnings(listing, gcloud(account('admin@acme.com'), viaProvider(SA)))).toEqual([]);
    expect(gcpIdentityNotes(listing, gcloud(account('admin@acme.com'), viaProvider(SA))))
      .toEqual([{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: SA }]);
    // Downloads that impersonate nothing need no grant; the target warning covers the rest.
    expect(gcpIdentityNotes(listing, gcloud(account('admin@acme.com'))))
      .toEqual([{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: null }]);
  });

  it('notes nothing when the account is known, the lookup merely failed, or gcloud has no account', () => {
    const expired: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: { status: 'unknown', reason: 'expired' } };
    const unrecordedUser: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: unrecorded };
    expect(gcpIdentityNotes(plainUser, gcloud(account('admin@acme.com')))).toEqual([]);
    expect(gcpIdentityNotes(expired, gcloud(account('admin@acme.com')))).toEqual([]);
    expect(gcpIdentityNotes(unrecordedUser, gcloud(account(null)))).toEqual([]);
    expect(gcpIdentityNotes(unrecordedUser, { kind: 'cli-missing' })).toEqual([]);
  });
});
