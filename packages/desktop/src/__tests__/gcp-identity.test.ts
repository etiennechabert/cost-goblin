import { describe, expect, it, vi } from 'vitest';
import type { GcloudRunResult, IdentityDeps } from '../main/gcp-identity.js';
import { resolveGcpIdentities } from '../main/gcp-identity.js';

const ADC_PATH = '/Users/a/.config/gcloud/application_default_credentials.json';
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
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE-KEY\n-----END PRIVATE KEY-----\n',
});

function enoent(): Error {
  return Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' });
}

function gcloud(account: string, configuration = 'default'): (args: readonly string[]) => Promise<GcloudRunResult> {
  return (args) => {
    if (args.includes('get-value')) return Promise.resolve({ kind: 'exited', code: 0, stdout: `${account}\n`, stderr: `Your active configuration is: [${configuration}]\n` });
    return Promise.resolve({ kind: 'exited', code: 0, stdout: JSON.stringify([{ name: configuration, is_active: true }]), stderr: '' });
  };
}

function deps(overrides: Partial<IdentityDeps>): IdentityDeps {
  return {
    env: { HOME: '/Users/a' },
    platform: 'darwin',
    readFile: (path) => (path === ADC_PATH ? Promise.resolve(IMPERSONATED_ADC) : Promise.reject(enoent())),
    runGcloud: gcloud('alice@acme.com'),
    lookupEmail: () => Promise.resolve({ status: 'known', email: 'alice@acme.com' }),
    ...overrides,
  };
}

describe('resolveGcpIdentities', () => {
  it('describes both paths and finds nothing wrong when they agree', async () => {
    const result = await resolveGcpIdentities({ impersonateServiceAccount: SA }, deps({}));
    expect(result).toEqual({
      listing: {
        kind: 'impersonated',
        credentialsPath: ADC_PATH,
        target: SA,
        source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } },
      },
      download: { kind: 'gcloud', account: 'alice@acme.com', configuration: 'default', impersonate: SA },
      warnings: [],
      notes: [],
    });
  });

  it('reproduces the switched-to-admin trap', async () => {
    const result = await resolveGcpIdentities(
      { impersonateServiceAccount: SA },
      deps({ runGcloud: gcloud('admin@acme.com', 'acme-admin') }),
    );
    expect(result.download).toMatchObject({ account: 'admin@acme.com', configuration: 'acme-admin' });
    expect(result.warnings).toEqual([{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' }]);
  });

  it('leaves the comparison to the user when the impersonated sign-in is not recorded', async () => {
    // The real shape: gcloud mints the impersonation source with
    // cloud-platform only, so Google will not name its owner.
    const result = await resolveGcpIdentities(
      { impersonateServiceAccount: SA },
      deps({ runGcloud: gcloud('admin@acme.com'), lookupEmail: () => Promise.resolve({ status: 'unknown', reason: 'not-recorded' }) }),
    );
    expect(result.warnings).toEqual([]);
    expect(result.notes).toEqual([{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', target: SA }]);
  });

  it('reads ADC from GOOGLE_APPLICATION_CREDENTIALS when set, and reports a missing file as not signed in', async () => {
    const readFile = vi.fn(() => Promise.reject(enoent()));
    const result = await resolveGcpIdentities({}, deps({ env: { HOME: '/Users/a', GOOGLE_APPLICATION_CREDENTIALS: '/sandbox/adc.json' }, readFile }));
    expect(readFile).toHaveBeenCalledWith('/sandbox/adc.json');
    expect(result.listing).toEqual({ kind: 'not-signed-in', credentialsPath: '/sandbox/adc.json' });
  });

  it('reports an unreadable or unparseable ADC file', async () => {
    const denied = await resolveGcpIdentities({}, deps({ readFile: () => Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' })) }));
    expect(denied.listing).toEqual({ kind: 'unreadable', credentialsPath: ADC_PATH });
    const garbage = await resolveGcpIdentities({}, deps({ readFile: () => Promise.resolve('not json') }));
    expect(garbage.listing).toEqual({ kind: 'unreadable', credentialsPath: ADC_PATH });
  });

  it('reports no location when neither HOME nor the env var is set', async () => {
    const result = await resolveGcpIdentities({}, deps({ env: {} }));
    expect(result.listing).toEqual({ kind: 'not-signed-in', credentialsPath: null });
  });

  it('uses a provider key file for both halves and never asks gcloud', async () => {
    const runGcloud = vi.fn(gcloud('admin@acme.com'));
    const result = await resolveGcpIdentities(
      { keyFile: '/keys/ci.json' },
      deps({ runGcloud, readFile: (path) => (path === '/keys/ci.json' ? Promise.resolve(KEY_FILE) : Promise.reject(enoent())) }),
    );
    expect(result).toEqual({
      listing: { kind: 'service-account', credentialsPath: '/keys/ci.json', email: 'ci-reader@acme-billing.iam.gserviceaccount.com', origin: 'key-file' },
      download: { kind: 'key-file', keyFile: '/keys/ci.json', email: 'ci-reader@acme-billing.iam.gserviceaccount.com' },
      warnings: [],
      notes: [],
    });
    expect(runGcloud).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('FAKE-KEY');
  });

  it('reports a key file it cannot read', async () => {
    const result = await resolveGcpIdentities({ keyFile: '/keys/missing.json' }, deps({ readFile: () => Promise.reject(enoent()) }));
    expect(result.listing).toEqual({ kind: 'unreadable', credentialsPath: '/keys/missing.json' });
    expect(result.download).toEqual({ kind: 'key-file', keyFile: '/keys/missing.json', email: null });
  });

  it('reports a missing CLI, a failing CLI, and an unset account', async () => {
    const missing = await resolveGcpIdentities({}, deps({ runGcloud: () => Promise.resolve({ kind: 'missing' }) }));
    expect(missing.download).toEqual({ kind: 'cli-missing' });

    const failing = await resolveGcpIdentities({}, deps({
      runGcloud: () => Promise.resolve({ kind: 'exited', code: 1, stdout: '', stderr: `ERROR: ${'x'.repeat(400)}` }),
    }));
    expect(failing.download.kind).toBe('cli-error');
    expect(failing.download.kind === 'cli-error' ? failing.download.message.length : 0).toBeLessThanOrEqual(301);

    const timedOut = await resolveGcpIdentities({}, deps({ runGcloud: () => Promise.resolve({ kind: 'failed', message: 'Timed out waiting for gcloud.' }) }));
    expect(timedOut.download).toEqual({ kind: 'cli-error', message: 'Timed out waiting for gcloud.' });

    const unset = await resolveGcpIdentities({}, deps({ runGcloud: gcloud('(unset)') }));
    expect(unset.download).toMatchObject({ kind: 'gcloud', account: null });
  });

  it('keeps the account when only the configuration listing fails', async () => {
    const runGcloud = (args: readonly string[]): Promise<GcloudRunResult> => (args.includes('get-value')
      ? Promise.resolve({ kind: 'exited', code: 0, stdout: 'alice@acme.com\n', stderr: '' })
      : Promise.resolve({ kind: 'exited', code: 2, stdout: '', stderr: 'boom' }));
    const result = await resolveGcpIdentities({}, deps({ runGcloud }));
    expect(result.download).toEqual({ kind: 'gcloud', account: 'alice@acme.com', configuration: null, impersonate: null });
  });

  it('asks gcloud only read-only config questions', async () => {
    const runGcloud = vi.fn(gcloud('alice@acme.com'));
    await resolveGcpIdentities({}, deps({ runGcloud }));
    const commands = runGcloud.mock.calls.map(([args]) => args.join(' '));
    expect(commands.sort()).toEqual(['config configurations list --format=json', 'config get-value account']);
  });

  it('never returns a secret from the ADC file', async () => {
    const result = await resolveGcpIdentities({ impersonateServiceAccount: SA }, deps({}));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('FAKE-SECRET');
    expect(serialized).not.toContain('FAKE-REFRESH');
  });
});
