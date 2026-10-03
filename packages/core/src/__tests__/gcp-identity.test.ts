import { describe, expect, it, vi } from 'vitest';
import {
  adcCredentialsLocation,
  classifyAccountLookupError,
  emailFromIdToken,
  gcpIdentityNotes,
  gcpIdentityWarnings,
  impersonationTargetFromUrl,
  parseActiveGcloudConfiguration,
  parseAdcJson,
  parseGcloudConfigValue,
  parseServiceAccountKeyEmail,
  resolveListingIdentity,
} from '../sync/gcp-identity.js';
import type { AuthorizedUserSecret } from '../sync/gcp-identity.js';
import type { GcpAccountLookup, GcpDownloadIdentity, GcpListingIdentity } from '../types/gcp-identity.js';

// ---- Fixture ADC files, in the shapes gcloud and the IAM console write them.
// Secrets are obviously fake; the tests also assert none of them survive into
// a resolved identity.

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
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
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

const SECRETS = ['d-FAKE-client-secret', '1//FAKE-refresh-token', 'FAKE\n'];

function without(record: Readonly<Record<string, unknown>>, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}

function known(email: string): (secret: AuthorizedUserSecret) => Promise<{ status: 'known'; email: string }> {
  return () => Promise.resolve({ status: 'known', email });
}

describe('parseAdcJson', () => {
  it('reads a plain-user ADC file, keeping the refresh secret for the lookup only', () => {
    const parsed = parseAdcJson(USER_ADC);
    expect(parsed).toEqual({
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
    expect(parsed.target).toBe('costgoblin-reader@acme-billing.iam.gserviceaccount.com');
    // The empty `account` gcloud writes is treated as absent, not as an email.
    expect(parsed.source).toMatchObject({ kind: 'user', account: null });
  });

  it('reads an impersonated ADC whose source is a service-account key', () => {
    const parsed = parseAdcJson({ ...IMPERSONATED_ADC, source_credentials: SERVICE_ACCOUNT_KEY });
    expect(parsed).toEqual({
      kind: 'impersonated',
      target: 'costgoblin-reader@acme-billing.iam.gserviceaccount.com',
      source: { kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email },
    });
  });

  it('reads a service-account key used as ADC', () => {
    expect(parseAdcJson(SERVICE_ACCOUNT_KEY)).toEqual({ kind: 'service-account', email: SERVICE_ACCOUNT_KEY.client_email });
  });

  it('reads workload identity federation, with and without impersonation', () => {
    expect(parseAdcJson(EXTERNAL_ADC)).toEqual({ kind: 'external', target: 'wif-reader@acme-billing.iam.gserviceaccount.com' });
    expect(parseAdcJson(without(EXTERNAL_ADC, 'service_account_impersonation_url'))).toEqual({ kind: 'external', target: null });
  });

  it('marks types it does not describe, and malformed members, as unrecognized', () => {
    expect(parseAdcJson({ type: 'gdch_service_account' })).toEqual({ kind: 'unrecognized', type: 'gdch_service_account' });
    expect(parseAdcJson({})).toEqual({ kind: 'unrecognized', type: null });
    // A service-account key with no email cannot be named.
    expect(parseAdcJson({ type: 'service_account' })).toEqual({ kind: 'unrecognized', type: 'service_account' });
    // An impersonated file whose URL names no target.
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
  it('extracts the service account from both IAM credentials verbs', () => {
    const base = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/sa@p.iam.gserviceaccount.com';
    expect(impersonationTargetFromUrl(`${base}:generateAccessToken`)).toBe('sa@p.iam.gserviceaccount.com');
    expect(impersonationTargetFromUrl(`${base}:generateIdToken`)).toBe('sa@p.iam.gserviceaccount.com');
  });

  it('rejects non-strings, unrelated URLs and over-long input', () => {
    expect(impersonationTargetFromUrl(undefined)).toBeNull();
    expect(impersonationTargetFromUrl('https://example.com/serviceAccounts/x')).toBeNull();
    expect(impersonationTargetFromUrl(`https://x/${'a'.repeat(300)}:generateAccessToken`)).toBeNull();
  });
});

describe('adcCredentialsLocation', () => {
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

  it('ignores CLOUDSDK_CONFIG, which the SDK does not honour either', () => {
    expect(adcCredentialsLocation({ HOME: '/h', CLOUDSDK_CONFIG: '/elsewhere' }, 'linux')?.path)
      .toBe('/h/.config/gcloud/application_default_credentials.json');
  });

  it('treats empty variables as unset and reports no location when none apply', () => {
    expect(adcCredentialsLocation({ GOOGLE_APPLICATION_CREDENTIALS: '', HOME: '/h' }, 'linux')?.origin).toBe('well-known');
    expect(adcCredentialsLocation({}, 'linux')).toBeNull();
    expect(adcCredentialsLocation({ HOME: '/h' }, 'win32')).toBeNull();
  });
});

describe('resolveListingIdentity', () => {
  const path = '/h/.config/gcloud/application_default_credentials.json';

  it('names a plain user through the lookup', async () => {
    const lookup = vi.fn(known('alice@acme.com'));
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), path, lookup);
    expect(identity).toEqual({ kind: 'user', credentialsPath: path, account: { status: 'known', email: 'alice@acme.com' } });
    expect(lookup).toHaveBeenCalledWith({ clientId: USER_ADC.client_id, clientSecret: USER_ADC.client_secret, refreshToken: USER_ADC.refresh_token });
  });

  it('skips the network when the file already names the account', async () => {
    const lookup = vi.fn(known('never@used.com'));
    const identity = await resolveListingIdentity(parseAdcJson({ ...USER_ADC, account: 'alice@acme.com' }), path, lookup);
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'known', email: 'alice@acme.com' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('names the human behind an impersonated credential, and its target', async () => {
    const identity = await resolveListingIdentity(parseAdcJson(IMPERSONATED_ADC), path, known('alice@acme.com'));
    expect(identity).toEqual({
      kind: 'impersonated',
      credentialsPath: path,
      target: 'costgoblin-reader@acme-billing.iam.gserviceaccount.com',
      source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } },
    });
  });

  it('carries a failed lookup through as a classified reason', async () => {
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), path, () => Promise.resolve({ status: 'unknown', reason: 'expired' }));
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'expired' } });
  });

  it('turns a throwing lookup into an unknown account rather than rejecting', async () => {
    const identity = await resolveListingIdentity(parseAdcJson(USER_ADC), path, () => Promise.reject(new Error('invalid_grant: Token has been expired or revoked.')));
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'expired' } });
  });

  it('reports a user ADC with no refresh token as un-nameable without calling out', async () => {
    const lookup = vi.fn(known('x@y.z'));
    const identity = await resolveListingIdentity(parseAdcJson(without(USER_ADC, 'refresh_token')), path, lookup);
    expect(identity).toMatchObject({ kind: 'user', account: { status: 'unknown', reason: 'expired' } });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('describes service-account, external, unrecognized and unparseable files', async () => {
    const lookup = known('unused@x.com');
    expect(await resolveListingIdentity(parseAdcJson(SERVICE_ACCOUNT_KEY), path, lookup))
      .toEqual({ kind: 'service-account', credentialsPath: path, email: SERVICE_ACCOUNT_KEY.client_email, origin: 'adc' });
    expect(await resolveListingIdentity(parseAdcJson(EXTERNAL_ADC), path, lookup))
      .toEqual({ kind: 'external', credentialsPath: path, target: 'wif-reader@acme-billing.iam.gserviceaccount.com' });
    expect(await resolveListingIdentity(parseAdcJson({ type: 'mystery' }), path, lookup))
      .toEqual({ kind: 'unrecognized', credentialsPath: path, type: 'mystery' });
    expect(await resolveListingIdentity(null, path, lookup)).toEqual({ kind: 'unreadable', credentialsPath: path });
  });

  it('never lets a secret reach the resolved identity', async () => {
    const fixtures: unknown[] = [USER_ADC, IMPERSONATED_ADC, SERVICE_ACCOUNT_KEY, EXTERNAL_ADC];
    for (const fixture of fixtures) {
      const identity = await resolveListingIdentity(parseAdcJson(fixture), path, known('alice@acme.com'));
      const serialized = JSON.stringify(identity);
      for (const secret of SECRETS) expect(serialized).not.toContain(secret);
    }
  });
});

describe('parseServiceAccountKeyEmail', () => {
  it('reads client_email from a key file, and nothing else', () => {
    expect(parseServiceAccountKeyEmail(SERVICE_ACCOUNT_KEY)).toBe(SERVICE_ACCOUNT_KEY.client_email);
    expect(parseServiceAccountKeyEmail(USER_ADC)).toBeNull();
    expect(parseServiceAccountKeyEmail('nope')).toBeNull();
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

describe('classifyAccountLookupError', () => {
  it('recognises an expired or revoked sign-in', () => {
    expect(classifyAccountLookupError(new Error('invalid_grant'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('invalid_rapt: reauth related error'))).toBe('expired');
    expect(classifyAccountLookupError(new Error('Token has been expired or revoked.'))).toBe('expired');
  });

  it('reports anything else as unreachable', () => {
    expect(classifyAccountLookupError(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'))).toBe('unreachable');
    expect(classifyAccountLookupError('weird')).toBe('unreachable');
  });
});

describe('gcloud stdout parsers', () => {
  it('reads `gcloud config get-value account`', () => {
    expect(parseGcloudConfigValue('alice@acme.com\n')).toBe('alice@acme.com');
    expect(parseGcloudConfigValue('\n')).toBeNull();
    expect(parseGcloudConfigValue('(unset)\n')).toBeNull();
  });

  it('picks the active configuration out of `configurations list --format=json`', () => {
    const stdout = JSON.stringify([
      { name: 'default', is_active: false, properties: {} },
      { name: 'acme-admin', is_active: true, properties: { core: { account: 'admin@acme.com' } } },
    ]);
    expect(parseActiveGcloudConfiguration(stdout)).toBe('acme-admin');
    expect(parseActiveGcloudConfiguration('[]')).toBeNull();
    expect(parseActiveGcloudConfiguration('Updates are available')).toBeNull();
  });
});

describe('gcpIdentityWarnings', () => {
  const path = '/adc.json';
  const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
  const OTHER_SA = 'company-reader@corp.iam.gserviceaccount.com';
  const alice: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };

  const impersonatedAs = (target: string, email = 'alice@acme.com'): GcpListingIdentity => ({
    kind: 'impersonated', credentialsPath: path, target, source: { kind: 'user', account: { status: 'known', email } },
  });
  const plainUser: GcpListingIdentity = { kind: 'user', credentialsPath: path, account: alice };
  const cli = (account: string | null, impersonate: string | null = null): GcpDownloadIdentity => ({
    kind: 'gcloud', account, configuration: 'default', impersonate,
  });

  it('is quiet when both paths agree', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA), cli('alice@acme.com', SA), SA)).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, cli('alice@acme.com'), null)).toEqual([]);
  });

  it('compares accounts and targets case-insensitively', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA.toUpperCase()), cli('ALICE@acme.com', SA), SA)).toEqual([]);
  });

  it('flags ADC impersonating a different service account than the provider', () => {
    expect(gcpIdentityWarnings(impersonatedAs(OTHER_SA), cli('alice@acme.com', SA), SA))
      .toEqual([{ kind: 'adc-target-mismatch', adcTarget: OTHER_SA, providerTarget: SA }]);
  });

  it('flags a provider that impersonates when ADC does not', () => {
    expect(gcpIdentityWarnings(plainUser, cli('alice@acme.com', SA), SA))
      .toEqual([{ kind: 'adc-not-impersonated', providerTarget: SA }]);
    const saAdc: GcpListingIdentity = { kind: 'service-account', credentialsPath: path, email: 'ci@x.iam.gserviceaccount.com', origin: 'adc' };
    expect(gcpIdentityWarnings(saAdc, cli('ci@x.iam.gserviceaccount.com', SA), SA))
      .toEqual([{ kind: 'adc-not-impersonated', providerTarget: SA }]);
  });

  it('treats federation by its own impersonation target', () => {
    const external = (target: string | null): GcpListingIdentity => ({ kind: 'external', credentialsPath: path, target });
    expect(gcpIdentityWarnings(external(SA), cli(null, SA), SA)).toEqual([]);
    expect(gcpIdentityWarnings(external(OTHER_SA), cli(null, SA), SA))
      .toEqual([{ kind: 'adc-target-mismatch', adcTarget: OTHER_SA, providerTarget: SA }]);
    expect(gcpIdentityWarnings(external(null), cli(null, SA), SA))
      .toEqual([{ kind: 'adc-not-impersonated', providerTarget: SA }]);
  });

  it('flags gcloud running as a different human than ADC', () => {
    expect(gcpIdentityWarnings(impersonatedAs(SA), cli('admin@acme.com', SA), SA))
      .toEqual([{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' }]);
    expect(gcpIdentityWarnings(plainUser, cli('admin@acme.com'), null))
      .toEqual([{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' }]);
  });

  it('reports every mismatch at once, provider checks first', () => {
    expect(gcpIdentityWarnings(impersonatedAs(OTHER_SA, 'bob@corp.com'), cli('alice@acme.com', SA), SA)).toEqual([
      { kind: 'adc-target-mismatch', adcTarget: OTHER_SA, providerTarget: SA },
      { kind: 'split-accounts', listingAccount: 'bob@corp.com', downloadAccount: 'alice@acme.com' },
    ]);
  });

  it('cannot compare accounts it does not know', () => {
    const unknownUser: GcpListingIdentity = { kind: 'user', credentialsPath: path, account: { status: 'unknown', reason: 'unreachable' } };
    expect(gcpIdentityWarnings(unknownUser, cli('admin@acme.com'), null)).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, cli(null), null)).toEqual([]);
    expect(gcpIdentityWarnings(plainUser, { kind: 'cli-missing' }, null)).toEqual([]);
  });

  it('says nothing about impersonation when ADC is missing — the panel already reports that', () => {
    expect(gcpIdentityWarnings({ kind: 'not-signed-in', credentialsPath: path }, cli('alice@acme.com', SA), SA)).toEqual([]);
    expect(gcpIdentityWarnings({ kind: 'unreadable', credentialsPath: path }, cli('alice@acme.com', SA), SA)).toEqual([]);
  });

  it('is quiet for a key-file provider: both halves run as the key', () => {
    const keyListing: GcpListingIdentity = { kind: 'service-account', credentialsPath: '/k.json', email: 'ci@x.iam.gserviceaccount.com', origin: 'key-file' };
    expect(gcpIdentityWarnings(keyListing, { kind: 'key-file', keyFile: '/k.json', email: 'ci@x.iam.gserviceaccount.com' }, null)).toEqual([]);
  });
});

describe('gcpIdentityNotes', () => {
  const path = '/adc.json';
  const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
  const unrecorded: GcpAccountLookup = { status: 'unknown', reason: 'not-recorded' };
  const cli = (account: string | null): GcpDownloadIdentity => ({ kind: 'gcloud', account, configuration: 'default', impersonate: SA });

  it('asks the user to compare when an impersonated sign-in does not name its human', () => {
    const listing: GcpListingIdentity = { kind: 'impersonated', credentialsPath: path, target: SA, source: { kind: 'user', account: unrecorded } };
    expect(gcpIdentityNotes(listing, cli('admin@acme.com')))
      .toEqual([{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', target: SA }]);
    // ...and the warning that would compare them stays quiet, rather than guessing.
    expect(gcpIdentityWarnings(listing, cli('admin@acme.com'), SA)).toEqual([]);
  });

  it('covers a plain-user ADC whose account is not recorded', () => {
    const listing: GcpListingIdentity = { kind: 'user', credentialsPath: path, account: unrecorded };
    expect(gcpIdentityNotes(listing, cli('admin@acme.com')))
      .toEqual([{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', target: null }]);
  });

  it('stays quiet when the account is known, the lookup merely failed, or gcloud has no account', () => {
    const known: GcpListingIdentity = { kind: 'user', credentialsPath: path, account: { status: 'known', email: 'alice@acme.com' } };
    const expired: GcpListingIdentity = { kind: 'user', credentialsPath: path, account: { status: 'unknown', reason: 'expired' } };
    const unrecordedUser: GcpListingIdentity = { kind: 'user', credentialsPath: path, account: unrecorded };
    expect(gcpIdentityNotes(known, cli('admin@acme.com'))).toEqual([]);
    expect(gcpIdentityNotes(expired, cli('admin@acme.com'))).toEqual([]);
    expect(gcpIdentityNotes(unrecordedUser, cli(null))).toEqual([]);
    expect(gcpIdentityNotes(unrecordedUser, { kind: 'cli-missing' })).toEqual([]);
  });
});
