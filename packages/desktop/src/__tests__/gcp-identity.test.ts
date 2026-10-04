import { describe, expect, it, vi } from 'vitest';
import { asBucketPath, asProviderName } from '@costgoblin/core';
import type { CostGoblinConfig, GcpAccountLookup } from '@costgoblin/core';
import type { GcloudCaptureResult } from '../main/gcloud-capture.js';
import type { IdentityDeps, IdentityProviderOptions } from '../main/gcp-identity.js';
import { createGcpIdentityResolver, gcpIdentitiesFor } from '../main/gcp-identity.js';
import type { GcpIdentityResolver } from '../main/gcp-identity.js';

const HOME = '/Users/a';
const ADC_PATH = `${HOME}/.config/gcloud/application_default_credentials.json`;
const ACTIVE_CONFIG_PATH = `${HOME}/.config/gcloud/active_config`;
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const OTHER_SA = 'company-reader@corp.iam.gserviceaccount.com';

/** A plain `gcloud auth application-default login` — the recommended setup. */
const USER_ADC = JSON.stringify({
  type: 'authorized_user',
  client_id: 'cid',
  client_secret: 'FAKE-SECRET',
  refresh_token: 'FAKE-REFRESH',
});

/** The legacy `application-default login --impersonate-service-account=<SA>`
 *  file. */
const IMPERSONATED_ADC = JSON.stringify({
  type: 'impersonated_service_account',
  service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
  delegates: [],
  source_credentials: {
    type: 'authorized_user',
    client_id: 'cid',
    client_secret: 'FAKE-SECRET',
    refresh_token: 'FAKE-REFRESH',
  },
});

const KEY_FILE = JSON.stringify({
  type: 'service_account',
  client_email: 'ci-reader@acme-billing.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----FAKE-KEY-----END PRIVATE KEY-----',
});

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

function configList(values: { account?: string; impersonate?: string; credentialFileOverride?: string; accessTokenFile?: string }): GcloudCaptureResult {
  const auth: Record<string, string> = {};
  if (values.impersonate !== undefined) auth['impersonate_service_account'] = values.impersonate;
  if (values.credentialFileOverride !== undefined) auth['credential_file_override'] = values.credentialFileOverride;
  if (values.accessTokenFile !== undefined) auth['access_token_file'] = values.accessTokenFile;
  return {
    kind: 'exited',
    code: 0,
    stdout: JSON.stringify({ core: values.account === undefined ? {} : { account: values.account }, ...(Object.keys(auth).length > 0 ? { auth } : {}) }),
    stderr: '',
  };
}

function files(entries: Readonly<Record<string, string>>): (path: string) => Promise<string> {
  return (path) => {
    const text = entries[path];
    return text === undefined ? Promise.reject(enoent()) : Promise.resolve(text);
  };
}

function deps(overrides: Partial<IdentityDeps>): IdentityDeps {
  return {
    env: { HOME },
    platform: 'darwin',
    readFile: files({ [ADC_PATH]: USER_ADC, [ACTIVE_CONFIG_PATH]: 'acme\n' }),
    runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com' })),
    lookupEmail: () => Promise.resolve({ status: 'known', email: 'alice@acme.com' }),
    ...overrides,
  };
}

function resolve(provider: IdentityProviderOptions, overrides: Partial<IdentityDeps> = {}): ReturnType<ReturnType<typeof createGcpIdentityResolver>['resolve']> {
  return createGcpIdentityResolver(deps(overrides)).resolve(provider);
}

describe('createGcpIdentityResolver', () => {
  const legacyAdc = { readFile: files({ [ADC_PATH]: IMPERSONATED_ADC, [ACTIVE_CONFIG_PATH]: 'acme\n' }) };

  it('lists a provider with a reader as that reader, minted from the plain ADC user, and finds nothing wrong', async () => {
    expect(await resolve({ impersonateServiceAccount: SA })).toEqual({
      listing: {
        kind: 'impersonated',
        file: { path: ADC_PATH, origin: 'well-known' },
        target: SA,
        source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } },
        via: { kind: 'provider', adcTarget: null },
      },
      download: {
        kind: 'gcloud',
        principal: { kind: 'account', account: 'alice@acme.com', fromEnv: false },
        impersonate: { target: SA, origin: 'provider' },
        configuration: 'acme',
      },
      adcLoginPath: null,
      gcloudImpersonation: null,
      warnings: [],
      notes: [],
    });
  });

  it('lists a provider without a reader as plain ADC', async () => {
    const result = await resolve({});
    expect(result.listing).toEqual({ kind: 'user', file: { path: ADC_PATH, origin: 'well-known' }, account: { status: 'known', email: 'alice@acme.com' } });
    expect(result.warnings).toEqual([]);
  });

  it('unwraps a legacy impersonated ADC to mint the provider s own reader — no target mismatch', async () => {
    const result = await resolve({ impersonateServiceAccount: OTHER_SA }, legacyAdc);
    expect(result.listing).toEqual({
      kind: 'impersonated',
      file: { path: ADC_PATH, origin: 'well-known' },
      target: OTHER_SA,
      source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } },
      via: { kind: 'provider', adcTarget: SA },
    });
    expect(result.download).toMatchObject({ impersonate: { target: OTHER_SA, origin: 'provider' } });
    expect(result.warnings).toEqual([]);
  });

  it('warns when a provider without a reader reads a legacy impersonated ADC: downloads bypass it', async () => {
    const result = await resolve({}, legacyAdc);
    expect(result.listing).toMatchObject({ kind: 'impersonated', target: SA, via: { kind: 'credential' } });
    expect(result.warnings).toEqual([{ kind: 'download-not-impersonated', listingTarget: SA, advice: { kind: 'set-reader', target: SA } }]);
  });

  it('reproduces the switched-to-admin trap — both accounts then need Token Creator on the reader', async () => {
    const result = await resolve({ impersonateServiceAccount: SA }, {
      runGcloud: () => Promise.resolve(configList({ account: 'admin@acme.com' })),
    });
    expect(result.download).toMatchObject({ principal: { account: 'admin@acme.com' } });
    expect(result.warnings).toEqual([{
      kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null,
      downloadPrincipal: { kind: 'account', account: 'admin@acme.com', fromEnv: false }, sharedTarget: SA,
    }]);
  });

  it('sees gcloud s own impersonation setting, which rsync honours without a flag', async () => {
    const gcloudImpersonates = { runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com', impersonate: 'ops-reader@corp.iam.gserviceaccount.com' })) };
    const legacy = await resolve({}, { ...legacyAdc, ...gcloudImpersonates });
    const ops = { origin: 'gcloud-config', target: 'ops-reader@corp.iam.gserviceaccount.com', delegates: [] };
    expect(legacy.download).toMatchObject({ impersonate: ops });
    expect(legacy.warnings).toEqual([{ kind: 'target-mismatch', listingTarget: SA, gcloud: ops, advice: { kind: 'set-reader', target: SA } }]);
    const plain = await resolve({}, gcloudImpersonates);
    expect(plain.warnings).toEqual([{ kind: 'listing-not-impersonated', gcloud: ops, advice: { kind: 'set-reader', target: ops.target } }]);
    // A provider s reader is passed as a flag, which beats gcloud s setting on the download half too...
    const withReader = await resolve({ impersonateServiceAccount: SA }, gcloudImpersonates);
    expect(withReader.download).toMatchObject({ impersonate: { target: SA, origin: 'provider' } });
    expect(withReader.warnings).toEqual([]);
    // ...but a terminal sign-in still honours gcloud s setting, so the panel is told about it.
    expect(withReader.gcloudImpersonation).toEqual(ops);
  });

  it('marks an account forced by CLOUDSDK_CORE_ACCOUNT, which `config set` cannot change — an empty one too', async () => {
    const result = await resolve({}, { env: { HOME, CLOUDSDK_CORE_ACCOUNT: 'admin@acme.com' } });
    expect(result.download).toMatchObject({ principal: { kind: 'account', fromEnv: true } });
    const empty = await resolve({}, { env: { HOME, CLOUDSDK_CORE_ACCOUNT: '' }, runGcloud: () => Promise.resolve(configList({})) });
    expect(empty.download).toMatchObject({ principal: { kind: 'account', account: null, fromEnv: true } });
  });

  it('marks gcloud settings that come from CostGoblin s environment, so their remedy names the variable', async () => {
    const result = await resolve({}, {
      env: { HOME, CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: OTHER_SA },
      runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com', impersonate: OTHER_SA })),
    });
    const fromEnv = { origin: 'env', target: OTHER_SA, delegates: [] };
    expect(result.download).toMatchObject({ impersonate: fromEnv });
    expect(result.gcloudImpersonation).toEqual(fromEnv);
    expect(result.warnings).toEqual([{ kind: 'listing-not-impersonated', gcloud: fromEnv, advice: { kind: 'set-reader', target: OTHER_SA } }]);
  });

  it('reports a pre-minted CLOUDSDK_AUTH_ACCESS_TOKEN without its value, and reads nothing it outranks', async () => {
    const readFile = vi.fn(files({ [ADC_PATH]: USER_ADC, '/g.json': USER_ADC }));
    const lookupEmail = vi.fn((): Promise<GcpAccountLookup> => Promise.resolve({ status: 'known', email: 'alice@acme.com' }));
    const result = await resolve({}, {
      env: { HOME, CLOUDSDK_AUTH_ACCESS_TOKEN: 'ya29.FAKE-TOKEN' },
      readFile,
      lookupEmail,
      runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com', credentialFileOverride: '/g.json' })),
    });
    expect(result.download).toMatchObject({ principal: { kind: 'access-token' } });
    expect(JSON.stringify(result)).not.toContain('FAKE-TOKEN');
    // The override is never read or refreshed: gcloud would not use it.
    expect(readFile.mock.calls.map(([path]) => path)).not.toContain('/g.json');
    expect(lookupEmail).toHaveBeenCalledTimes(1);
  });

  it('does not describe a credential file override that an access-token file outranks', async () => {
    const readFile = vi.fn(files({ [ADC_PATH]: USER_ADC, '/g.json': KEY_FILE }));
    const result = await resolve({}, {
      env: { HOME, CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '/sandbox/token' },
      readFile,
      runGcloud: () => Promise.resolve(configList({ credentialFileOverride: '/g.json', accessTokenFile: '/sandbox/token' })),
    });
    expect(result.download).toMatchObject({ principal: { kind: 'access-token-file', path: '/sandbox/token', origin: 'env' } });
    expect(readFile.mock.calls.map(([path]) => path)).not.toContain('/g.json');
  });

  it('redacts an inline-JSON GOOGLE_APPLICATION_CREDENTIALS rather than echoing or reading it', async () => {
    const readFile = vi.fn(files({}));
    const result = await resolve({}, { env: { HOME, GOOGLE_APPLICATION_CREDENTIALS: KEY_FILE }, readFile });
    expect(result.listing).toEqual({ kind: 'unreadable', file: { path: '<value of GOOGLE_APPLICATION_CREDENTIALS is not a file path>', origin: 'env' } });
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY');
    expect(readFile.mock.calls.map(([path]) => path)).not.toContain(KEY_FILE);
  });

  it('describes a provider key file that impersonates by itself as the download s impersonation — no warning, no reader advice', async () => {
    const result = await resolve({ keyFile: '/keys/legacy.json' }, { readFile: files({ '/keys/legacy.json': IMPERSONATED_ADC }) });
    expect(result.listing).toMatchObject({ kind: 'impersonated', target: SA, via: { kind: 'credential' }, file: { origin: 'key-file' } });
    expect(result.download).toMatchObject({
      principal: { kind: 'key-file', origin: 'provider', email: null },
      impersonate: { origin: 'credential-file', target: SA, fileOrigin: 'provider' },
    });
    expect(result.warnings).toEqual([]);
  });

  it('lists a provider whose reader is the ADC key s own account with that key — no self-impersonation, no warning', async () => {
    const readerKey = JSON.stringify({ type: 'service_account', client_email: SA, private_key: 'FAKE-KEY' });
    const result = await resolve({ impersonateServiceAccount: SA }, { readFile: files({ [ADC_PATH]: readerKey }) });
    expect(result.listing).toEqual({ kind: 'service-account', file: { path: ADC_PATH, origin: 'well-known' }, email: SA });
    expect(result.warnings).toEqual([]);
  });

  it('lists a provider whose reader is federation s own target through that federation — no self-impersonation', async () => {
    const federated = JSON.stringify({
      type: 'external_account',
      audience: 'aud',
      service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${SA}:generateAccessToken`,
    });
    const result = await resolve({ impersonateServiceAccount: SA }, { readFile: files({ [ADC_PATH]: federated }) });
    expect(result.listing).toEqual({ kind: 'external', file: { path: ADC_PATH, origin: 'well-known' }, target: SA });
    expect(result.warnings).toEqual([]);
  });

  it('reads ADC from GOOGLE_APPLICATION_CREDENTIALS when set, and reports a missing file as not signed in there', async () => {
    const readFile = vi.fn(files({}));
    const result = await resolve({}, { env: { HOME, GOOGLE_APPLICATION_CREDENTIALS: '/sandbox/adc.json' }, readFile });
    expect(readFile).toHaveBeenCalledWith('/sandbox/adc.json');
    expect(result.listing).toEqual({ kind: 'not-signed-in', file: { path: '/sandbox/adc.json', origin: 'env' } });
  });

  it('says where a sign-in would land when CLOUDSDK_CONFIG moves gcloud away from what the SDK reads', async () => {
    const result = await resolve({}, { env: { HOME, CLOUDSDK_CONFIG: '/work/gcloud' }, readFile: files({}) });
    expect(result.adcLoginPath).toBe('/work/gcloud/application_default_credentials.json');
    expect(result.download).toMatchObject({ configuration: 'default' });
  });

  it('reports an unreadable or unparseable ADC file', async () => {
    const denied = await resolve({}, { readFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) });
    expect(denied.listing).toEqual({ kind: 'unreadable', file: { path: ADC_PATH, origin: 'well-known' } });
    const garbage = await resolve({}, { readFile: () => Promise.resolve('not json') });
    expect(garbage.listing).toEqual({ kind: 'unreadable', file: { path: ADC_PATH, origin: 'well-known' } });
  });

  it('reports no location when neither HOME nor the env var is set', async () => {
    expect((await resolve({}, { env: {} })).listing).toEqual({ kind: 'not-signed-in', file: null });
  });

  it('uses a provider key file for listing and downloads, and never reads ADC', async () => {
    const readFile = vi.fn(files({ '/keys/ci.json': KEY_FILE }));
    const result = await resolve({ keyFile: '/keys/ci.json' }, { readFile });
    expect(result).toEqual({
      listing: { kind: 'service-account', file: { path: '/keys/ci.json', origin: 'key-file' }, email: 'ci-reader@acme-billing.iam.gserviceaccount.com' },
      download: {
        kind: 'gcloud',
        principal: { kind: 'key-file', path: '/keys/ci.json', origin: 'provider', email: 'ci-reader@acme-billing.iam.gserviceaccount.com' },
        impersonate: null,
        configuration: 'default',
      },
      adcLoginPath: null,
      gcloudImpersonation: null,
      warnings: [],
      notes: [],
    });
    expect(readFile.mock.calls.map(([path]) => path)).not.toContain(ADC_PATH);
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY');
  });

  it('reports a key file it cannot read, and a missing CLI even for a key-file provider', async () => {
    const result = await resolve({ keyFile: '/keys/missing.json' }, {
      readFile: files({}),
      runGcloud: () => Promise.resolve({ kind: 'missing' }),
    });
    expect(result.listing).toEqual({ kind: 'unreadable', file: { path: '/keys/missing.json', origin: 'key-file' } });
    // Key-file downloads still go through `gcloud storage rsync`.
    expect(result.download).toEqual({ kind: 'cli-missing' });
  });

  it('names who gcloud s own credential file override is', async () => {
    const result = await resolve({}, {
      readFile: files({ [ADC_PATH]: USER_ADC, '/g.json': KEY_FILE }),
      runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com', credentialFileOverride: '/g.json' })),
    });
    expect(result.download).toMatchObject({
      principal: { kind: 'key-file', path: '/g.json', origin: 'gcloud-config', email: 'ci-reader@acme-billing.iam.gserviceaccount.com' },
    });
  });

  it('reports a failing, timed-out or unreadable gcloud', async () => {
    const failing = await resolve({}, { runGcloud: () => Promise.resolve({ kind: 'exited', code: 1, stdout: '', stderr: `ERROR: ${'x'.repeat(400)}` }) });
    expect(failing.download.kind).toBe('cli-error');
    expect(failing.download.kind === 'cli-error' ? failing.download.message.length : 0).toBeLessThanOrEqual(301);

    const timedOut = await resolve({}, { runGcloud: () => Promise.resolve({ kind: 'timeout' }) });
    expect(timedOut.download).toEqual({ kind: 'cli-error', message: 'Timed out waiting for gcloud.' });

    const nag = await resolve({}, { runGcloud: () => Promise.resolve({ kind: 'exited', code: 0, stdout: 'Updates are available', stderr: '' }) });
    expect(nag.download.kind).toBe('cli-error');

    const unset = await resolve({}, { runGcloud: () => Promise.resolve(configList({})) });
    expect(unset.download).toMatchObject({ kind: 'gcloud', principal: { kind: 'account', account: null } });
  });

  it('asks gcloud one read-only question', async () => {
    const runGcloud = vi.fn(() => Promise.resolve(configList({ account: 'alice@acme.com' })));
    await resolve({}, { runGcloud });
    expect(runGcloud.mock.calls).toEqual([[['config', 'list', '--format=json']]]);
  });

  it('shares one gcloud read and one ADC read among concurrent callers, but not later ones', async () => {
    const runGcloud = vi.fn(() => Promise.resolve(configList({ account: 'alice@acme.com' })));
    const lookupEmail = vi.fn((): Promise<GcpAccountLookup> => Promise.resolve({ status: 'known', email: 'alice@acme.com' }));
    const resolver = createGcpIdentityResolver(deps({ runGcloud, lookupEmail }));
    await Promise.all([resolver.resolve({ impersonateServiceAccount: SA }), resolver.resolve({})]);
    expect(runGcloud).toHaveBeenCalledTimes(1);
    expect(lookupEmail).toHaveBeenCalledTimes(1);
    // A later Re-check — after a sign-in, say — must not get the old answer.
    await resolver.resolve({});
    expect(runGcloud).toHaveBeenCalledTimes(2);
    expect(lookupEmail).toHaveBeenCalledTimes(2);
  });

  it('never returns a secret from the ADC file', async () => {
    for (const overrides of [{}, legacyAdc]) {
      for (const provider of [{}, { impersonateServiceAccount: SA }]) {
        const serialized = JSON.stringify(await resolve(provider, overrides));
        expect(serialized).not.toContain('FAKE-SECRET');
        expect(serialized).not.toContain('FAKE-REFRESH');
      }
    }
  });
});

describe('gcpIdentitiesFor', () => {
  const sync = { daily: { bucket: asBucketPath('gs://b/focus/daily'), retentionDays: 365 }, intervalMinutes: 60 };
  const CONFIG: CostGoblinConfig = {
    providers: [
      { name: asProviderName('aws-main'), type: 'aws', credentialsProfile: 'default', sync: { ...sync, daily: { bucket: asBucketPath('s3-bucket/x'), retentionDays: 90 } } },
      { name: asProviderName('gcp-main'), type: 'gcp', impersonateServiceAccount: SA, sync },
      { name: asProviderName('gcp-key'), type: 'gcp', keyFile: '/keys/ci.json', sync },
    ],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
  };

  function recordingResolver(): { resolver: () => GcpIdentityResolver; seen: IdentityProviderOptions[] } {
    const seen: IdentityProviderOptions[] = [];
    const real = createGcpIdentityResolver(deps({}));
    return { seen, resolver: () => ({ resolve: (provider) => { seen.push(provider); return real.resolve(provider); } }) };
  }

  it('applies the named GCP provider s impersonation and key file', async () => {
    const { resolver, seen } = recordingResolver();
    const result = await gcpIdentitiesFor('gcp-main', () => Promise.resolve(CONFIG), resolver);
    expect(result.status).toBe('ok');
    expect(seen[0]).toMatchObject({ impersonateServiceAccount: SA });
    await gcpIdentitiesFor('gcp-key', () => Promise.resolve(CONFIG), resolver);
    expect(seen[1]).toMatchObject({ keyFile: '/keys/ci.json' });
  });

  it('treats anything but a string as the wizard s "no provider yet", without loading the config', async () => {
    const { resolver, seen } = recordingResolver();
    const loadConfig = vi.fn(() => Promise.resolve(CONFIG));
    expect((await gcpIdentitiesFor(undefined, loadConfig, resolver)).status).toBe('ok');
    expect((await gcpIdentitiesFor(42, loadConfig, resolver)).status).toBe('ok');
    expect(seen).toEqual([{}, {}]);
    expect(loadConfig).not.toHaveBeenCalled();
  });

  it('refuses an unknown or non-GCP provider, and a named provider when no config loads', async () => {
    const { resolver } = recordingResolver();
    expect(await gcpIdentitiesFor('nope', () => Promise.resolve(CONFIG), resolver))
      .toEqual({ status: 'unavailable', reason: 'No provider named "nope" is configured.' });
    expect(await gcpIdentitiesFor('aws-main', () => Promise.resolve(CONFIG), resolver))
      .toEqual({ status: 'unavailable', reason: '"aws-main" is not a Google Cloud provider.' });
    expect((await gcpIdentitiesFor('gcp-main', () => Promise.resolve(null), resolver)).status).toBe('unavailable');
  });

  it('reports a resolver failure as unavailable rather than rejecting the IPC call', async () => {
    const failing = (): GcpIdentityResolver => ({ resolve: () => Promise.reject(new Error('boom')) });
    expect(await gcpIdentitiesFor(undefined, () => Promise.resolve(null), failing)).toEqual({ status: 'unavailable', reason: 'boom' });
  });
});
