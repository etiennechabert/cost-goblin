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
    readFile: files({ [ADC_PATH]: IMPERSONATED_ADC, [ACTIVE_CONFIG_PATH]: 'acme\n' }),
    runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com' })),
    lookupEmail: () => Promise.resolve({ status: 'known', email: 'alice@acme.com' }),
    ...overrides,
  };
}

function resolve(provider: IdentityProviderOptions, overrides: Partial<IdentityDeps> = {}): ReturnType<ReturnType<typeof createGcpIdentityResolver>['resolve']> {
  return createGcpIdentityResolver(deps(overrides)).resolve(provider);
}

describe('createGcpIdentityResolver', () => {
  it('describes both paths and finds nothing wrong when they agree', async () => {
    expect(await resolve({ impersonateServiceAccount: SA })).toEqual({
      listing: {
        kind: 'impersonated',
        file: { path: ADC_PATH, origin: 'well-known' },
        target: SA,
        source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } },
      },
      download: {
        kind: 'gcloud',
        principal: { kind: 'account', account: 'alice@acme.com', fromEnv: false },
        impersonate: { target: SA, origin: 'provider' },
        configuration: 'acme',
      },
      adcLoginPath: null,
      warnings: [],
      notes: [],
    });
  });

  it('reproduces the switched-to-admin trap', async () => {
    const result = await resolve({ impersonateServiceAccount: SA }, {
      runGcloud: () => Promise.resolve(configList({ account: 'admin@acme.com' })),
    });
    expect(result.download).toMatchObject({ principal: { account: 'admin@acme.com' } });
    expect(result.warnings).toEqual([{
      kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadAccountFromEnv: false,
    }]);
  });

  it('sees gcloud s own impersonation setting, which rsync honours without a flag', async () => {
    const result = await resolve({}, {
      runGcloud: () => Promise.resolve(configList({ account: 'alice@acme.com', impersonate: 'ops@corp.iam.gserviceaccount.com' })),
    });
    expect(result.download).toMatchObject({ impersonate: { target: 'ops@corp.iam.gserviceaccount.com', origin: 'gcloud-config' } });
    expect(result.warnings).toEqual([{
      kind: 'target-mismatch', listingTarget: SA, download: { target: 'ops@corp.iam.gserviceaccount.com', origin: 'gcloud-config' },
    }]);
  });

  it('warns when a provider without impersonation reads an impersonated ADC', async () => {
    expect((await resolve({})).warnings).toEqual([{ kind: 'download-not-impersonated', listingTarget: SA }]);
  });

  it('marks an account forced by CLOUDSDK_CORE_ACCOUNT, which `config set` cannot change', async () => {
    const result = await resolve({}, { env: { HOME, CLOUDSDK_CORE_ACCOUNT: 'admin@acme.com' } });
    expect(result.download).toMatchObject({ principal: { kind: 'account', fromEnv: true } });
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
      readFile: files({ [ADC_PATH]: IMPERSONATED_ADC, '/g.json': KEY_FILE }),
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
    const serialized = JSON.stringify(await resolve({ impersonateServiceAccount: SA }));
    expect(serialized).not.toContain('FAKE-SECRET');
    expect(serialized).not.toContain('FAKE-REFRESH');
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
