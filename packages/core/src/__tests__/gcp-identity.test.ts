import { describe, expect, it, vi } from 'vitest';
import {
  activeGcloudConfigPath,
  activeGcloudConfiguration,
  adcCredentialsLocation,
  adcLoginImpersonationToKeep,
  adcLoginPath,
  applyProviderImpersonation,
  assembleDownloadIdentity,
  classifyAccountLookupError,
  credentialEmail,
  displayablePath,
  emailFromIdToken,
  gcloudConfigDir,
  gcloudEnvFacts,
  gcloudImpersonationSetting,
  gcloudTokenWins,
  gcpIdentityNotes,
  gcpIdentityWarnings,
  grantsEmailScope,
  impersonationTargetFromUrl,
  isPathPlaceholder,
  looksLikeFilePath,
  parseAdcJson,
  parseGcloudConfigList,
  resolveListingIdentity,
  summarizeCredentialFile,
} from '../sync/gcp-identity.js';
import type { AuthorizedUserSecret, GcloudConfigValues, GcloudEnvFacts } from '../sync/gcp-identity.js';
import { classifyImpersonatedAdc } from '../sync/gcp-adc-classify.js';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpGcloudImpersonation,
  GcpListingIdentity,
  GcpReaderAdvice,
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

  it('marks a legacy impersonated file whose source the SDK cannot build as unusable, not as a working impersonation', () => {
    // The listing client reads the file with the same classifier, so the
    // panel can never call working what it would reject.
    for (const source of [undefined, 'a string', { type: 'authorized_user', client_id: 'x', client_secret: 'y' }, { type: 'service_account', client_email: 'a@b' }]) {
      const file = source === undefined ? without(IMPERSONATED_ADC, 'source_credentials') : { ...IMPERSONATED_ADC, source_credentials: source };
      expect(parseAdcJson(file)).toEqual({ kind: 'unrecognized', type: 'impersonated_service_account' });
      expect(classifyImpersonatedAdc(file)).toEqual({ kind: 'unusable' });
    }
    // A source the SDK accepts but CostGoblin cannot unwrap stays an
    // impersonation — usable as it is, by a provider without a reader.
    expect(parseAdcJson({ ...IMPERSONATED_ADC, source_credentials: EXTERNAL_ADC }))
      .toEqual({ kind: 'impersonated', target: SA, source: { kind: 'other', type: 'external_account' } });
  });

  it('reads a legacy file s delegation chain', () => {
    expect(classifyImpersonatedAdc({ ...IMPERSONATED_ADC, delegates: [OTHER_SA, 42] }))
      .toMatchObject({ kind: 'impersonated', target: SA, delegates: [OTHER_SA] });
    expect(classifyImpersonatedAdc(USER_ADC)).toEqual({ kind: 'not-impersonated' });
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

  it('never echoes a GOOGLE_APPLICATION_CREDENTIALS value that is not a path', () => {
    const inline = JSON.stringify(SERVICE_ACCOUNT_KEY);
    const location = adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: inline, HOME: '/h' }, 'linux');
    expect(location).toEqual({ path: '<value of GOOGLE_APPLICATION_CREDENTIALS is not a file path>', origin: 'env' });
    expect(isPathPlaceholder(location?.path ?? '')).toBe(true);
    for (const secret of SECRETS) expect(JSON.stringify(location)).not.toContain(secret);
  });

  it('knows what looks like a file path', () => {
    expect(looksLikeFilePath('/keys/sa.json')).toBe(true);
    expect(looksLikeFilePath(String.raw`C:\keys\sa.json`)).toBe(true);
    expect(looksLikeFilePath('{"type":"service_account"}')).toBe(false);
    expect(looksLikeFilePath('line one\nline two')).toBe(false);
    expect(looksLikeFilePath('x'.repeat(2000))).toBe(false);
    expect(looksLikeFilePath('private_key=abc')).toBe(false);
    expect(displayablePath('ya29.token\n', 'auth/access_token_file')).toBe('<value of auth/access_token_file is not a file path>');
    expect(isPathPlaceholder('/real/path')).toBe(false);
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
      via: { kind: 'credential' },
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
      // A delegation chain impersonates its LAST account, through the others.
      impersonateServiceAccount: 'ops@corp.iam.gserviceaccount.com',
      impersonationDelegates: ['hop@p.iam.gserviceaccount.com'],
      credentialFileOverride: '/k.json',
      accessTokenFile: '/t',
    });
  });

  it('treats absent sections as unset, and non-JSON as unreadable', () => {
    expect(parseGcloudConfigList('{}')).toEqual({ account: null, impersonateServiceAccount: null, impersonationDelegates: [], credentialFileOverride: null, accessTokenFile: null });
    expect(parseGcloudConfigList('Updates are available')).toBeNull();
  });

  it('names the active configuration the way gcloud resolves it', () => {
    expect(activeGcloudConfiguration({}, 'acme-admin\n')).toBe('acme-admin');
    expect(activeGcloudConfiguration({ CLOUDSDK_ACTIVE_CONFIG_NAME: 'ci' }, 'acme-admin')).toBe('ci');
    expect(activeGcloudConfiguration({}, null)).toBe('default');
    expect(activeGcloudConfiguration({}, '  \n')).toBe('default');
  });
});

describe('gcloudEnvFacts', () => {
  it('reports which gcloud settings CostGoblin s environment sets — an empty value counts', () => {
    expect(gcloudEnvFacts({})).toEqual({
      accountFromEnv: false, accessTokenInEnv: false, impersonation: 'gcloud-config', credentialFileOverride: 'gcloud-config', accessTokenFile: 'gcloud-config',
    });
    expect(gcloudEnvFacts({
      CLOUDSDK_CORE_ACCOUNT: '',
      CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: SA,
      CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/k.json',
      CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '/t',
      CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.FAKE',
    })).toEqual({ accountFromEnv: true, accessTokenInEnv: true, impersonation: 'env', credentialFileOverride: 'env', accessTokenFile: 'env' });
    // gcloud ignores an empty token (`if access_token:`).
    expect(gcloudEnvFacts({ CLOUDSDK_AUTH_ACCESS_TOKEN: '' }).accessTokenInEnv).toBe(false);
  });
});

describe('assembleDownloadIdentity', () => {
  const CONFIG: GcloudConfigValues = { account: 'alice@acme.com', impersonateServiceAccount: null, impersonationDelegates: [], credentialFileOverride: null, accessTokenFile: null };
  const FACTS: GcloudEnvFacts = gcloudEnvFacts({});
  const base = { config: CONFIG, configuration: 'default', facts: FACTS, providerKeyFile: null, providerTarget: null, overrideFile: null };
  const keyFile = { path: '/keys/ci.json', summary: { email: 'ci@x.iam.gserviceaccount.com', impersonates: null } };

  it('runs as the active account by default', () => {
    expect(assembleDownloadIdentity(base)).toEqual({
      kind: 'gcloud',
      principal: { kind: 'account', account: 'alice@acme.com', fromEnv: false },
      impersonate: null,
      configuration: 'default',
    });
  });

  it('lets the provider s impersonation win over gcloud s own, which keeps its origin and chain', () => {
    const config = { ...CONFIG, impersonateServiceAccount: OTHER_SA, impersonationDelegates: [SA] };
    expect(assembleDownloadIdentity({ ...base, config })).toMatchObject({ impersonate: { target: OTHER_SA, origin: 'gcloud-config', delegates: [SA] } });
    expect(assembleDownloadIdentity({ ...base, config, facts: gcloudEnvFacts({ CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA }) }))
      .toMatchObject({ impersonate: { origin: 'env' } });
    expect(assembleDownloadIdentity({ ...base, config, providerTarget: SA })).toMatchObject({ impersonate: { target: SA, origin: 'provider' } });
    expect(gcloudImpersonationSetting(config, FACTS)).toEqual({ origin: 'gcloud-config', target: OTHER_SA, delegates: [SA] });
    expect(gcloudImpersonationSetting(CONFIG, FACTS)).toBeNull();
  });

  it('follows gcloud s credential precedence: env token, token file, key file, then account', () => {
    expect(assembleDownloadIdentity({ ...base, providerKeyFile: keyFile }))
      .toMatchObject({ principal: { kind: 'key-file', path: '/keys/ci.json', origin: 'provider', email: 'ci@x.iam.gserviceaccount.com' } });
    const override = { ...CONFIG, credentialFileOverride: '/g.json' };
    expect(assembleDownloadIdentity({ ...base, config: override, overrideFile: { email: 'g@x.iam.gserviceaccount.com', impersonates: null } }))
      .toMatchObject({ principal: { kind: 'key-file', path: '/g.json', origin: 'gcloud-config', email: 'g@x.iam.gserviceaccount.com' } });
    expect(assembleDownloadIdentity({ ...base, config: override, facts: gcloudEnvFacts({ CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: '/g.json' }) }))
      .toMatchObject({ principal: { kind: 'key-file', origin: 'env', email: null } });
    // The provider's key is passed as the env override, beating gcloud's.
    expect(assembleDownloadIdentity({ ...base, config: override, providerKeyFile: keyFile }))
      .toMatchObject({ principal: { kind: 'key-file', origin: 'provider' } });
    // auth/access_token_file outranks everything, the key file included.
    expect(assembleDownloadIdentity({ ...base, config: { ...CONFIG, accessTokenFile: '/t' }, providerKeyFile: keyFile }))
      .toMatchObject({ principal: { kind: 'access-token-file', path: '/t', origin: 'gcloud-config' } });
    // ...and CLOUDSDK_AUTH_ACCESS_TOKEN outranks the token file.
    const tokenFacts = gcloudEnvFacts({ CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.FAKE-TOKEN' });
    const token = assembleDownloadIdentity({ ...base, config: { ...CONFIG, accessTokenFile: '/t' }, facts: tokenFacts, providerKeyFile: keyFile });
    expect(token).toMatchObject({ principal: { kind: 'access-token' } });
    expect(JSON.stringify(token)).not.toContain('FAKE-TOKEN');
    expect(gcloudTokenWins(CONFIG, tokenFacts)).toBe(true);
    expect(gcloudTokenWins({ ...CONFIG, accessTokenFile: '/t' }, FACTS)).toBe(true);
    expect(gcloudTokenWins(override, FACTS)).toBe(false);
  });

  it('marks an account forced by CLOUDSDK_CORE_ACCOUNT, even an empty one', () => {
    expect(assembleDownloadIdentity({ ...base, config: { ...CONFIG, account: null }, facts: gcloudEnvFacts({ CLOUDSDK_CORE_ACCOUNT: '' }) }))
      .toMatchObject({ principal: { kind: 'account', account: null, fromEnv: true } });
  });

  it('reports a credential file that impersonates by itself as the download s impersonation', () => {
    const impersonatingKey = { path: '/keys/legacy.json', summary: { email: null, impersonates: SA } };
    expect(assembleDownloadIdentity({ ...base, providerKeyFile: impersonatingKey })).toMatchObject({
      principal: { kind: 'key-file', origin: 'provider', email: null },
      impersonate: { origin: 'credential-file', target: SA, fileOrigin: 'provider' },
    });
    const override = { ...CONFIG, credentialFileOverride: '/g.json' };
    expect(assembleDownloadIdentity({ ...base, config: override, overrideFile: { email: null, impersonates: OTHER_SA } }))
      .toMatchObject({ impersonate: { origin: 'credential-file', target: OTHER_SA, fileOrigin: 'gcloud-config' } });
    // gcloud's own setting impersonates on top of the file, so it is what downloads end up as.
    expect(assembleDownloadIdentity({ ...base, config: { ...override, impersonateServiceAccount: SA }, overrideFile: { email: null, impersonates: OTHER_SA } }))
      .toMatchObject({ impersonate: { origin: 'gcloud-config', target: SA } });
  });

  it('never echoes an access-token-file value that is not a path', () => {
    const identity = assembleDownloadIdentity({ ...base, config: { ...CONFIG, accessTokenFile: 'ya29.FAKE-TOKEN\n' } });
    expect(identity).toMatchObject({ principal: { kind: 'access-token-file', path: '<value of auth/access_token_file is not a file path>' } });
    expect(JSON.stringify(identity)).not.toContain('FAKE-TOKEN');
  });

  it('summarizes a credential file by who it is and whom it impersonates', async () => {
    const lookup = known('alice@acme.com');
    expect(summarizeCredentialFile(await resolveListingIdentity(parseAdcJson(SERVICE_ACCOUNT_KEY), ADC_FILE, lookup)))
      .toEqual({ email: SERVICE_ACCOUNT_KEY.client_email, impersonates: null });
    expect(summarizeCredentialFile(await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), ADC_FILE, lookup)))
      .toEqual({ email: null, impersonates: SA });
    expect(summarizeCredentialFile(await resolveListingIdentity(parseAdcJson(EXTERNAL_ADC), ADC_FILE, lookup)))
      .toEqual({ email: null, impersonates: 'wif-reader@acme-billing.iam.gserviceaccount.com' });
  });
});

describe('applyProviderImpersonation', () => {
  const alice: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };

  it('leaves listing as ADC when the provider names no reader — a legacy impersonated file still lists as its own target', async () => {
    const legacy = await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), ADC_FILE, known('alice@acme.com'));
    expect(applyProviderImpersonation(legacy, null)).toBe(legacy);
    const plain: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: alice };
    expect(applyProviderImpersonation(plain, null)).toBe(plain);
  });

  it('impersonates the provider s reader, minted from a plain ADC user', () => {
    expect(applyProviderImpersonation({ kind: 'user', file: ADC_FILE, account: alice }, SA)).toEqual({
      kind: 'impersonated', file: ADC_FILE, target: SA, source: { kind: 'user', account: alice }, via: { kind: 'provider', adcTarget: null },
    });
  });

  it('unwraps a legacy impersonated ADC to the login underneath it — never chaining through the file s own target', async () => {
    const legacy = await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), ADC_FILE, () => Promise.resolve({ status: 'unknown', reason: 'not-recorded' }));
    expect(applyProviderImpersonation(legacy, OTHER_SA)).toEqual({
      kind: 'impersonated',
      file: ADC_FILE,
      target: OTHER_SA,
      source: { kind: 'user', account: { status: 'unknown', reason: 'not-recorded' } },
      via: { kind: 'provider', adcTarget: SA },
    });
    // Applying it twice changes nothing: the bypassed target is kept.
    const once = applyProviderImpersonation(legacy, OTHER_SA);
    expect(applyProviderImpersonation(once, OTHER_SA)).toEqual(once);
  });

  it('mints from a service-account key or a federated credential used as ADC', () => {
    const keyAdc: GcpCredentialFile = { path: '/keys/ci.json', origin: 'env' };
    expect(applyProviderImpersonation({ kind: 'service-account', file: keyAdc, email: 'ci@x.iam.gserviceaccount.com' }, SA)).toMatchObject({
      kind: 'impersonated', target: SA, source: { kind: 'service-account', email: 'ci@x.iam.gserviceaccount.com' }, via: { kind: 'provider', adcTarget: null },
    });
    expect(applyProviderImpersonation({ kind: 'external', file: ADC_FILE, target: 'wif@x.iam.gserviceaccount.com' }, SA)).toMatchObject({
      kind: 'impersonated', target: SA, source: { kind: 'federated', target: 'wif@x.iam.gserviceaccount.com' },
    });
  });

  it('never mints the reader from a principal that already is the reader', async () => {
    // A key for the reader itself: used as it is, as createGcsStorage does.
    const readerKey: GcpListingIdentity = { kind: 'service-account', file: ADC_FILE, email: SA };
    expect(applyProviderImpersonation(readerKey, SA)).toBe(readerKey);
    expect(applyProviderImpersonation(readerKey, SA.toUpperCase())).toBe(readerKey);
    // Federation that itself impersonates the reader.
    const federated: GcpListingIdentity = { kind: 'external', file: ADC_FILE, target: SA };
    expect(applyProviderImpersonation(federated, SA)).toBe(federated);
    // A legacy file whose key source is the reader: unwrapped to that key.
    const legacyKey = await resolveListingIdentity(parseAdcJson({ ...IMPERSONATED_ADC, source_credentials: { ...SERVICE_ACCOUNT_KEY, client_email: OTHER_SA } }), ADC_FILE, known('x'));
    expect(applyProviderImpersonation(legacyKey, OTHER_SA)).toEqual({ kind: 'service-account', file: ADC_FILE, email: OTHER_SA });
  });

  it('calls a legacy file unusable for a reader when its source cannot be unwrapped', async () => {
    const nested = await resolveListingIdentity(parseAdcJson({ ...IMPERSONATED_ADC, source_credentials: EXTERNAL_ADC }), ADC_FILE, known('x'));
    // Without a reader it lists as it is...
    expect(applyProviderImpersonation(nested, null)).toBe(nested);
    // ...but the listing client refuses to mint a reader from it.
    expect(applyProviderImpersonation(nested, OTHER_SA)).toEqual({ kind: 'unrecognized', file: ADC_FILE, type: 'impersonated_service_account' });
  });

  it('keeps a missing, unreadable or unusable ADC as it is — there is nothing to mint from', () => {
    const missing: GcpListingIdentity = { kind: 'not-signed-in', file: ADC_FILE };
    const unreadable: GcpListingIdentity = { kind: 'unreadable', file: ADC_FILE };
    const unrecognized: GcpListingIdentity = { kind: 'unrecognized', file: ADC_FILE, type: 'mystery' };
    for (const identity of [missing, unreadable, unrecognized]) expect(applyProviderImpersonation(identity, SA)).toBe(identity);
  });
});

describe('gcpIdentityWarnings / gcpIdentityNotes', () => {
  const alice: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };
  const unrecorded: GcpAccountLookup = { status: 'unknown', reason: 'not-recorded' };

  /** A legacy `--impersonate-service-account` ADC file, used as it is (a
   *  provider without a reader). */
  const legacyAdc = (target: string, account: GcpAccountLookup = alice): GcpListingIdentity => ({
    kind: 'impersonated', file: ADC_FILE, target, source: { kind: 'user', account }, via: { kind: 'credential' },
  });
  const plainUser: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: alice };
  /** Listing for a provider with a reader, the way the resolver builds it. */
  const withReader = (adc: GcpListingIdentity, reader: string): GcpListingIdentity => applyProviderImpersonation(adc, reader);
  const gcloud = (principal: GcpDownloadPrincipal, impersonate: GcpDownloadImpersonation | null = null): GcpDownloadIdentity => (
    { kind: 'gcloud', principal, impersonate, configuration: 'default' }
  );
  const account = (email: string | null, fromEnv = false): GcpDownloadPrincipal => ({ kind: 'account', account: email, fromEnv });
  const viaProvider = (target: string): GcpDownloadImpersonation => ({ target, origin: 'provider' });
  const viaGcloud = (target: string, delegates: readonly string[] = []): GcpGcloudImpersonation => ({ target, origin: 'gcloud-config', delegates });
  const keyFile: GcpCredentialFile = { path: '/k.json', origin: 'key-file' };
  const keyListing: GcpListingIdentity = { kind: 'service-account', file: keyFile, email: 'ci@x.iam.gserviceaccount.com' };
  const keyPrincipal: GcpDownloadPrincipal = { kind: 'key-file', path: '/k.json', origin: 'provider', email: 'ci@x.iam.gserviceaccount.com' };
  const setReader = (target: string): GcpReaderAdvice => ({ kind: 'set-reader', target });

  it('is quiet when both paths agree', () => {
    expect(gcpIdentityWarnings(withReader(plainUser, SA), gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com')))).toEqual([]);
    expect(gcpIdentityWarnings(legacyAdc(SA), gcloud(account('alice@acme.com'), viaGcloud(SA)))).toEqual([]);
  });

  it('raises no impersonation warning for a provider with a reader, whatever ADC holds', () => {
    // Plain ADC: listing mints the reader from the user, downloads pass it as a flag.
    expect(gcpIdentityWarnings(withReader(plainUser, SA), gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
    // A legacy ADC naming another account: unwrapped, so its target is irrelevant.
    expect(gcpIdentityWarnings(withReader(legacyAdc(OTHER_SA), SA), gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
  });

  it('compares accounts and targets case-insensitively', () => {
    expect(gcpIdentityWarnings(legacyAdc(SA.toUpperCase()), gcloud(account('ALICE@acme.com'), viaGcloud(SA)))).toEqual([]);
  });

  it('is quiet when ADC already IS the reader: a key for it, or federation impersonating it', () => {
    // SA-key ADC whose email is the reader: listing uses the key, downloads
    // impersonate the reader — one account reached two ways.
    const readerKey: GcpListingIdentity = { kind: 'service-account', file: ADC_FILE, email: SA };
    const listing = withReader(readerKey, SA);
    expect(listing).toBe(readerKey);
    expect(gcpIdentityWarnings(listing, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
    expect(gcpIdentityNotes(listing, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
    const federated = withReader({ kind: 'external', file: ADC_FILE, target: SA }, SA);
    expect(federated).toMatchObject({ kind: 'external', target: SA });
    expect(gcpIdentityWarnings(federated, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
  });

  it('flags gcloud s own impersonation disagreeing with a legacy ADC s target — and offers the reader', () => {
    expect(gcpIdentityWarnings(legacyAdc(SA), gcloud(account('alice@acme.com'), viaGcloud(OTHER_SA))))
      .toEqual([{ kind: 'target-mismatch', listingTarget: SA, gcloud: viaGcloud(OTHER_SA), advice: setReader(SA) }]);
  });

  it('flags gcloud impersonating on its own when listing does not', () => {
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com'), viaGcloud(SA))))
      .toEqual([{ kind: 'listing-not-impersonated', gcloud: viaGcloud(SA), advice: setReader(SA) }]);
    // A key-file provider still downloads through gcloud, which applies its own impersonation setting — but can't name a reader.
    expect(gcpIdentityWarnings(keyListing, gcloud(keyPrincipal, viaGcloud(OTHER_SA))))
      .toEqual([{ kind: 'listing-not-impersonated', gcloud: viaGcloud(OTHER_SA), advice: { kind: 'key-file-provider' } }]);
    // Env-sourced: carried through so the remedy can name the variable.
    const fromEnv: GcpGcloudImpersonation = { target: SA, origin: 'env', delegates: [] };
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com'), fromEnv)))
      .toEqual([{ kind: 'listing-not-impersonated', gcloud: fromEnv, advice: setReader(SA) }]);
  });

  it('is quiet when listing already IS gcloud s impersonation target', () => {
    const readerKey: GcpListingIdentity = { kind: 'service-account', file: ADC_FILE, email: SA };
    expect(gcpIdentityWarnings(readerKey, gcloud(account('alice@acme.com'), viaGcloud(SA)))).toEqual([]);
  });

  it('never offers a reader it cannot be: a delegation chain, a non-service-account, or what gcloud already is', () => {
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com'), viaGcloud(SA, [OTHER_SA]))))
      .toEqual([{ kind: 'listing-not-impersonated', gcloud: viaGcloud(SA, [OTHER_SA]), advice: { kind: 'delegation-chain', target: SA, delegates: [OTHER_SA] } }]);
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com'), viaGcloud('Not-An-SA@example.com'))))
      .toEqual([{ kind: 'listing-not-impersonated', gcloud: viaGcloud('Not-An-SA@example.com'), advice: { kind: 'not-a-reader', target: 'Not-An-SA@example.com' } }]);
    // gcloud is signed in AS the legacy target: naming it would have gcloud impersonate itself.
    expect(gcpIdentityWarnings(legacyAdc(SA), gcloud(account(SA), viaGcloud(OTHER_SA)))[0])
      .toEqual({ kind: 'target-mismatch', listingTarget: SA, gcloud: viaGcloud(OTHER_SA), advice: { kind: 'download-is-target', target: SA } });
  });

  it('flags a legacy impersonated ADC on a provider without a reader: downloads bypass it', () => {
    expect(gcpIdentityWarnings(legacyAdc(SA), gcloud(account('alice@acme.com'))))
      .toEqual([{ kind: 'download-not-impersonated', listingTarget: SA, advice: setReader(SA) }]);
    // ...unless gcloud already authenticates as that account.
    expect(gcpIdentityWarnings(legacyAdc(SA), gcloud({ kind: 'key-file', path: '/sa.json', origin: 'gcloud-config', email: SA }))).toEqual([]);
  });

  it('is quiet for a key file that impersonates by itself: both halves read the same file', () => {
    const legacyKey: GcpCredentialFile = { path: '/keys/legacy.json', origin: 'key-file' };
    const listing: GcpListingIdentity = { kind: 'impersonated', file: legacyKey, target: SA, source: { kind: 'user', account: alice }, via: { kind: 'credential' } };
    const download = gcloud(
      { kind: 'key-file', path: '/keys/legacy.json', origin: 'provider', email: null },
      { origin: 'credential-file', target: SA, fileOrigin: 'provider' },
    );
    expect(gcpIdentityWarnings(listing, download)).toEqual([]);
    // gcloud's own setting impersonates on top of it: a mismatch, but never fixed with a reader.
    const onTop = gcloud({ kind: 'key-file', path: '/keys/legacy.json', origin: 'provider', email: null }, viaGcloud(OTHER_SA));
    expect(gcpIdentityWarnings(listing, onTop))
      .toEqual([{ kind: 'target-mismatch', listingTarget: SA, gcloud: viaGcloud(OTHER_SA), advice: { kind: 'key-file-provider' } }]);
  });

  it('flags gcloud running as a different principal than listing, with what it needs to fix it', () => {
    expect(gcpIdentityWarnings(withReader(plainUser, SA), gcloud(account('admin@acme.com', true), viaProvider(SA)))).toEqual([{
      kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadPrincipal: account('admin@acme.com', true), sharedTarget: SA,
    }]);
    const keyAdc: GcpCredentialFile = { path: '/keys/ci.json', origin: 'env' };
    const saAdc: GcpListingIdentity = { kind: 'service-account', file: keyAdc, email: 'ci@x.iam.gserviceaccount.com' };
    expect(gcpIdentityWarnings(saAdc, gcloud(account('alice@acme.com')))).toEqual([{
      kind: 'split-accounts', listingAccount: 'ci@x.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: keyAdc, downloadPrincipal: account('alice@acme.com'), sharedTarget: null,
    }]);
    // A reader minted from a key ADC: the key is still what gcloud would need.
    expect(gcpIdentityWarnings(withReader(saAdc, SA), gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([{
      kind: 'split-accounts', listingAccount: 'ci@x.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: keyAdc, downloadPrincipal: account('alice@acme.com'), sharedTarget: SA,
    }]);
    // gcloud's own credential file override is carried, so the remedy can unset it.
    const override: GcpDownloadPrincipal = { kind: 'key-file', path: '/g.json', origin: 'gcloud-config', email: 'g@x.iam.gserviceaccount.com' };
    expect(gcpIdentityWarnings(plainUser, gcloud(override))).toEqual([{
      kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'g@x.iam.gserviceaccount.com', listingKeyFile: null, downloadPrincipal: override, sharedTarget: null,
    }]);
  });

  it('reports every mismatch at once, targets first', () => {
    expect(gcpIdentityWarnings(legacyAdc(OTHER_SA, { status: 'known', email: 'bob@corp.com' }), gcloud(account('alice@acme.com'), viaGcloud(SA)))).toEqual([
      { kind: 'target-mismatch', listingTarget: OTHER_SA, gcloud: viaGcloud(SA), advice: setReader(OTHER_SA) },
      { kind: 'split-accounts', listingAccount: 'bob@corp.com', downloadAccount: 'alice@acme.com', listingKeyFile: null, downloadPrincipal: account('alice@acme.com'), sharedTarget: null },
    ]);
  });

  it('never reports a provider-origin impersonation, which drives both halves', () => {
    // Unreachable through the resolver (listing would carry the same reader);
    // the rule is that only gcloud's own setting can disagree with listing.
    expect(gcpIdentityWarnings(plainUser, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
  });

  it('cannot compare what it cannot name', () => {
    const unknownUser: GcpListingIdentity = { kind: 'user', file: ADC_FILE, account: { status: 'unknown', reason: 'unreachable' } };
    expect(gcpIdentityWarnings(unknownUser, gcloud(account('admin@acme.com')))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud(account(null)))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud({ kind: 'access-token-file', path: '/t', origin: 'env' }))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, gcloud({ kind: 'access-token' }))).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, { kind: 'cli-missing' })).toEqual([]);
    const federated = withReader({ kind: 'external', file: ADC_FILE, target: null }, SA);
    expect(gcpIdentityWarnings(federated, gcloud(account('alice@acme.com'), viaProvider(SA)))).toEqual([]);
  });

  it('says nothing about impersonation when ADC is missing — the panel already reports that', () => {
    expect(gcpIdentityWarnings({ kind: 'not-signed-in', file: ADC_FILE }, gcloud(account('alice@acme.com'), viaGcloud(SA)))).toEqual([]);
    expect(gcpIdentityWarnings({ kind: 'unreadable', file: ADC_FILE }, gcloud(account('alice@acme.com'), viaGcloud(SA)))).toEqual([]);
  });

  it('is quiet for a key-file provider whose downloads use the same key', () => {
    expect(gcpIdentityWarnings(keyListing, gcloud(keyPrincipal))).toEqual([]);
  });

  it('asks the user to compare when a legacy ADC does not name its human, naming what downloads impersonate', () => {
    // A provider with a reader, minted from the unrecorded login inside the legacy file.
    const listing = withReader(legacyAdc(OTHER_SA, unrecorded), SA);
    expect(gcpIdentityWarnings(listing, gcloud(account('admin@acme.com'), viaProvider(SA)))).toEqual([]);
    expect(gcpIdentityNotes(listing, gcloud(account('admin@acme.com'), viaProvider(SA))))
      .toEqual([{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: SA }]);
    // The legacy file used as it is: downloads impersonate nothing, so need no grant; the target warning covers the rest.
    expect(gcpIdentityNotes(legacyAdc(SA, unrecorded), gcloud(account('admin@acme.com'))))
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
