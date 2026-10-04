import { describe, expect, it, vi } from 'vitest';
import { asBucketPath, asProviderName } from '@costgoblin/core';
import type { CostGoblinConfig, GcpAccountLookup } from '@costgoblin/core';
import type { GcloudCaptureResult } from '../main/gcloud-capture.js';
import type { GcpIdentityResolver, IdentityDeps, IdentityProviderOptions } from '../main/gcp-identity.js';
import { createGcpIdentityResolver, gcpIdentitiesFor } from '../main/gcp-identity.js';

const HOME = '/Users/a';
const ADC_PATH = `${HOME}/.config/gcloud/application_default_credentials.json`;
const ACTIVE_CONFIG_PATH = `${HOME}/.config/gcloud/active_config`;

const USER_ADC = JSON.stringify({ type: 'authorized_user', client_id: 'cid', client_secret: 'FAKE-SECRET', refresh_token: 'FAKE-REFRESH' });

const KEY_FILE = JSON.stringify({
  type: 'service_account',
  client_email: 'ci-reader@acme-billing.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----FAKE-KEY-----END PRIVATE KEY-----',
});

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

function configList(account?: string): GcloudCaptureResult {
  return { kind: 'exited', code: 0, stdout: JSON.stringify({ core: account === undefined ? {} : { account } }), stderr: '' };
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
    runGcloud: () => Promise.resolve(configList('alice@acme.com')),
    lookupEmail: () => Promise.resolve({ status: 'known', email: 'alice@acme.com' }),
    ...overrides,
  };
}

function resolve(provider: IdentityProviderOptions, overrides: Partial<IdentityDeps> = {}): ReturnType<GcpIdentityResolver['resolve']> {
  return createGcpIdentityResolver(deps(overrides)).resolve(provider);
}

describe('createGcpIdentityResolver', () => {
  it('describes both paths and finds nothing wrong when they agree', async () => {
    expect(await resolve({})).toEqual({
      listing: { kind: 'user', file: { path: ADC_PATH, origin: 'well-known' }, account: { status: 'known', email: 'alice@acme.com' } },
      download: { kind: 'gcloud', account: 'alice@acme.com', configuration: 'acme' },
      reader: null,
      splitAccounts: null,
    });
  });

  it('carries the provider s reader, which both paths impersonate', async () => {
    const reader = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
    const result = await resolve({ impersonateServiceAccount: reader });
    expect(result.reader).toBe(reader);
    // The accounts it is minted from are still the ones shown and compared.
    expect(result.listing.kind).toBe('user');
    expect(result.splitAccounts).toBeNull();
  });

  it('never reads or echoes a GOOGLE_APPLICATION_CREDENTIALS value that is not a path', async () => {
    const readFile = vi.fn(files({}));
    const result = await resolve({}, { env: { HOME, GOOGLE_APPLICATION_CREDENTIALS: '{"type":"service_account","private_key":"x"}' }, readFile });
    expect(readFile).not.toHaveBeenCalledWith(expect.stringContaining('private_key'));
    expect(result.listing).toEqual({ kind: 'unreadable', file: { path: '<value of GOOGLE_APPLICATION_CREDENTIALS is not a file path>', origin: 'env' } });
  });

  it('reproduces the switched-to-admin trap', async () => {
    const result = await resolve({}, { runGcloud: () => Promise.resolve(configList('admin@acme.com')) });
    expect(result.splitAccounts).toEqual({ listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' });
  });

  it('reads ADC from GOOGLE_APPLICATION_CREDENTIALS when set, and reports a missing file as not signed in there', async () => {
    const readFile = vi.fn(files({}));
    const result = await resolve({}, { env: { HOME, GOOGLE_APPLICATION_CREDENTIALS: '/sandbox/adc.json' }, readFile });
    expect(readFile).toHaveBeenCalledWith('/sandbox/adc.json');
    expect(result.listing).toEqual({ kind: 'not-signed-in', file: { path: '/sandbox/adc.json', origin: 'env' } });
  });

  it('reports an unreadable ADC file, and no location without HOME', async () => {
    const denied = await resolve({}, { readFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) });
    expect(denied.listing).toEqual({ kind: 'unreadable', file: { path: ADC_PATH, origin: 'well-known' } });
    expect((await resolve({}, { readFile: () => Promise.resolve('not json') })).listing.kind).toBe('unreadable');
    expect((await resolve({}, { env: {} })).listing).toEqual({ kind: 'not-signed-in', file: null });
  });

  it('uses a provider key file for both halves, never reads ADC, but still needs gcloud', async () => {
    const readFile = vi.fn(files({ '/keys/ci.json': KEY_FILE }));
    const result = await resolve({ keyFile: '/keys/ci.json' }, { readFile });
    expect(result).toEqual({
      listing: { kind: 'service-account', file: { path: '/keys/ci.json', origin: 'key-file' }, email: 'ci-reader@acme-billing.iam.gserviceaccount.com' },
      download: { kind: 'key-file', path: '/keys/ci.json', email: 'ci-reader@acme-billing.iam.gserviceaccount.com' },
      reader: null,
      splitAccounts: null,
    });
    expect(readFile.mock.calls.map(([path]) => path)).not.toContain(ADC_PATH);
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY');

    const noCli = await resolve({ keyFile: '/keys/missing.json' }, { readFile: files({}), runGcloud: () => Promise.resolve({ kind: 'missing' }) });
    expect(noCli.listing).toEqual({ kind: 'unreadable', file: { path: '/keys/missing.json', origin: 'key-file' } });
    expect(noCli.download).toEqual({ kind: 'cli-missing' });
  });

  it('reports a failing, timed-out or unreadable gcloud, and an unset account', async () => {
    const failing = await resolve({}, { runGcloud: () => Promise.resolve({ kind: 'exited', code: 1, stdout: '', stderr: `ERROR: ${'x'.repeat(400)}` }) });
    expect(failing.download.kind === 'cli-error' ? failing.download.message.length : 0).toBeLessThanOrEqual(301);
    expect((await resolve({}, { runGcloud: () => Promise.resolve({ kind: 'timeout' }) })).download)
      .toEqual({ kind: 'cli-error', message: 'Timed out waiting for gcloud.' });
    expect((await resolve({}, { runGcloud: () => Promise.resolve({ kind: 'exited', code: 0, stdout: 'Updates are available', stderr: '' }) })).download.kind)
      .toBe('cli-error');
    expect((await resolve({}, { runGcloud: () => Promise.resolve(configList()) })).download)
      .toEqual({ kind: 'gcloud', account: null, configuration: 'acme' });
  });

  it('asks gcloud one read-only question', async () => {
    const runGcloud = vi.fn(() => Promise.resolve(configList('alice@acme.com')));
    await resolve({}, { runGcloud });
    expect(runGcloud.mock.calls).toEqual([[['config', 'list', '--format=json']]]);
  });

  it('shares one gcloud read and one ADC read among concurrent callers, but not later ones', async () => {
    const runGcloud = vi.fn(() => Promise.resolve(configList('alice@acme.com')));
    const lookupEmail = vi.fn((): Promise<GcpAccountLookup> => Promise.resolve({ status: 'known', email: 'alice@acme.com' }));
    const resolver = createGcpIdentityResolver(deps({ runGcloud, lookupEmail }));
    await Promise.all([resolver.resolve({}), resolver.resolve({})]);
    expect(runGcloud).toHaveBeenCalledTimes(1);
    expect(lookupEmail).toHaveBeenCalledTimes(1);
    // A later Re-check — after a sign-in, say — must not get the old answer.
    await resolver.resolve({});
    expect(runGcloud).toHaveBeenCalledTimes(2);
  });

  it('never returns a secret from the ADC file', async () => {
    const serialized = JSON.stringify(await resolve({}));
    expect(serialized).not.toContain('FAKE-SECRET');
    expect(serialized).not.toContain('FAKE-REFRESH');
  });
});

describe('gcpIdentitiesFor', () => {
  const sync = { daily: { bucket: asBucketPath('gs://b/focus/daily'), retentionDays: 365 }, intervalMinutes: 60 };
  const CONFIG: CostGoblinConfig = {
    providers: [
      { name: asProviderName('aws-main'), type: 'aws', credentialsProfile: 'default', sync: { ...sync, daily: { bucket: asBucketPath('s3-bucket/x'), retentionDays: 90 } } },
      { name: asProviderName('gcp-key'), type: 'gcp', keyFile: '/keys/ci.json', sync },
    ],
    defaults: { periodDays: 30, costMetric: 'effective', lagDays: 2 },
  };

  function recordingResolver(): { resolver: () => GcpIdentityResolver; seen: IdentityProviderOptions[] } {
    const seen: IdentityProviderOptions[] = [];
    const real = createGcpIdentityResolver(deps({}));
    return { seen, resolver: () => ({ resolve: (provider) => { seen.push(provider); return real.resolve(provider); } }) };
  }

  it('applies the named GCP provider s key file', async () => {
    const { resolver, seen } = recordingResolver();
    expect((await gcpIdentitiesFor('gcp-key', () => Promise.resolve(CONFIG), resolver)).status).toBe('ok');
    expect(seen[0]).toMatchObject({ keyFile: '/keys/ci.json' });
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
    expect((await gcpIdentitiesFor('gcp-key', () => Promise.resolve(null), resolver)).status).toBe('unavailable');
  });

  it('reports a resolver failure as unavailable rather than rejecting the IPC call', async () => {
    const failing = (): GcpIdentityResolver => ({ resolve: () => Promise.reject(new Error('boom')) });
    expect(await gcpIdentitiesFor(undefined, () => Promise.resolve(null), failing)).toEqual({ status: 'unavailable', reason: 'boom' });
  });
});
