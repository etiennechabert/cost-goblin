import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpIdentities,
  GcpIdentityResult,
  GcpListingIdentity,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { GcpIdentityPanel } from '../components/gcp-identity-panel.js';

const ADC: GcpCredentialFile = { path: '/home/me/.config/gcloud/application_default_credentials.json', origin: 'well-known' };
const ENV_FILE: GcpCredentialFile = { path: '/etc/creds/adc.json', origin: 'env' };
const KEY_FILE: GcpCredentialFile = { path: '/keys/reader.json', origin: 'key-file' };
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';

const userListing = (account: GcpAccountLookup, file: GcpCredentialFile = ADC): GcpListingIdentity => ({ kind: 'user', file, account });
const gcloud = (account: string | null): GcpDownloadIdentity => ({ kind: 'gcloud', account, configuration: 'default' });

function ok(identities: Partial<GcpIdentities> & Pick<GcpIdentities, 'listing' | 'download'>): GcpIdentityResult {
  return { status: 'ok', identities: { reader: null, splitAccounts: null, ...identities } };
}

function renderPanel(result: GcpIdentityResult | Error, context: 'wizard' | 'provider' = 'provider') {
  const api = new MockCostApi();
  if (result instanceof Error) vi.spyOn(api, 'getGcpIdentities').mockRejectedValue(result);
  else api.gcpIdentitiesResult = result;
  render(
    <CostApiProvider value={api}>
      <GcpIdentityPanel providerName="gcp-main" context={context} />
    </CostApiProvider>,
  );
  return screen.getByRole('region', { name: 'Signed in as (gcp-main)' });
}

/** The listing and download paths: the `<dl>` either way (behind Details on a
 *  healthy panel). */
async function paths(panel: HTMLElement): Promise<HTMLElement> {
  await waitFor(() => { expect(panel.querySelector('dl')).not.toBeNull(); });
  const dl = panel.querySelector('dl');
  if (!(dl instanceof HTMLElement)) throw new Error('paths missing');
  return dl;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('GcpIdentityPanel — loading and failures', () => {
  it('says it is checking, with Re-check held, until the identities arrive', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getGcpIdentities').mockReturnValue(new Promise<GcpIdentityResult>(() => undefined));
    render(
      <CostApiProvider value={api}>
        <GcpIdentityPanel context="provider" />
      </CostApiProvider>,
    );
    const panel = screen.getByRole('region', { name: 'Signed in as' });
    expect(within(panel).getByText('Checking Google Cloud credentials…')).toBeDefined();
    await waitFor(() => { expect(within(panel).getByRole('button', { name: 'Re-check' })).toHaveProperty('disabled', true); });
  });

  it('reports a lookup that failed outright', async () => {
    const panel = renderPanel(new Error('gcloud timed out after 20s'));
    expect(await within(panel).findByText("Couldn't check credentials: gcloud timed out after 20s")).toBeDefined();
    expect(within(panel).getByRole('button', { name: 'Re-check' })).toHaveProperty('disabled', false);
  });
});

describe('GcpIdentityPanel — Data Management paths', () => {
  it('names a credential file it could not read, and the key-file remedy for a provider key', async () => {
    const panel = renderPanel(ok({ listing: { kind: 'unreadable', file: KEY_FILE }, download: gcloud('alice@acme.com') }));
    const dl = await paths(panel);
    expect(within(dl).getByText("Couldn't read the credential file").parentElement?.textContent).toContain("check the provider's keyFile");
    expect(within(dl).getByText('/keys/reader.json')).toBeDefined();
  });

  it.each([
    { type: 'external_account', text: 'A external_account credential' },
    { type: null, text: 'A non-standard credential' },
  ])('describes a $type credential it does not model', async ({ type, text }) => {
    const panel = renderPanel(ok({ listing: { kind: 'other', file: ADC, type }, download: gcloud('alice@acme.com') }));
    const dl = await paths(panel);
    expect(within(dl).getByText(text)).toBeDefined();
    expect(within(dl).getByText(`Application Default Credentials · ${ADC.path}`)).toBeDefined();
  });

  it('says which file GOOGLE_APPLICATION_CREDENTIALS names', async () => {
    const panel = renderPanel(ok({ listing: userListing({ status: 'known', email: 'alice@acme.com' }, ENV_FILE), download: gcloud('alice@acme.com') }));
    const dl = await paths(panel);
    expect(within(dl).getByText(`Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS) · ${ENV_FILE.path}`)).toBeDefined();
  });

  it.each([
    { reason: 'unreachable' as const, text: "a Google account (couldn't reach Google to check which)" },
    { reason: 'not-recorded' as const, text: "your Google account (the credential doesn't record which)" },
  ])('describes an account it could not name because it is $reason', async ({ reason, text }) => {
    const panel = renderPanel(ok({ listing: userListing({ status: 'unknown', reason }), download: gcloud('alice@acme.com') }));
    // Nothing to act on: the paths sit behind Details.
    await waitFor(() => { expect(panel.querySelector('details')).not.toBeNull(); });
    expect(within(await paths(panel)).getByText(text)).toBeDefined();
  });

  it('reports gcloud failing to name its configuration', async () => {
    const panel = renderPanel(ok({ listing: userListing({ status: 'known', email: 'alice@acme.com' }), download: { kind: 'cli-error', message: 'ERROR: (gcloud.config.list) config is corrupt' } }));
    const dl = await paths(panel);
    expect(within(dl).getByText("gcloud couldn't report its configuration")).toBeDefined();
    expect(within(dl).getByText('ERROR: (gcloud.config.list) config is corrupt')).toBeDefined();
    // Needs action, so the paths are not folded away.
    expect(panel.querySelector('details')).toBeNull();
  });

  it('reports a provider key that is not a readable service-account key', async () => {
    const panel = renderPanel(ok({
      listing: { kind: 'service-account', file: KEY_FILE, email: SA },
      download: { kind: 'key-file', path: KEY_FILE.path, email: null },
    }));
    const dl = await paths(panel);
    expect(within(dl).getByText("Couldn't read the service account key")).toBeDefined();
    // Listing reads the same key, so both paths name it.
    expect(within(dl).getAllByText(`Provider keyFile · ${KEY_FILE.path}`)).toHaveLength(2);
  });

  it('reads as an impersonated ADC file s account when downloads use the provider key', async () => {
    const panel = renderPanel(ok({
      listing: { kind: 'impersonated', file: ADC, target: SA },
      download: { kind: 'key-file', path: KEY_FILE.path, email: 'ci@acme.iam.gserviceaccount.com' },
    }));
    // Healthy: one line, no bypass warning (the key file is not gcloud's own account).
    await waitFor(() => { expect(panel.querySelector('details')).not.toBeNull(); });
    expect(panel.querySelector('p')?.textContent).toBe(`ci@acme.iam.gserviceaccount.com · reads as ${SA}`);
    expect(within(panel).queryByRole('note')).toBeNull();
  });

  it('raises no bypass warning while gcloud has no account, and says so instead', async () => {
    const panel = renderPanel(ok({ listing: { kind: 'impersonated', file: ADC, target: SA }, download: gcloud(null) }));
    const dl = await paths(panel);
    expect(within(dl).getByText('No active gcloud account')).toBeDefined();
    expect(within(panel).queryByRole('note')).toBeNull();
  });
});

describe('GcpIdentityPanel — wizard line', () => {
  it.each([
    { email: 'ci@acme.iam.gserviceaccount.com', text: 'ci@acme.iam.gserviceaccount.com' },
    { email: null, text: 'An unreadable key file' },
  ])('shows a key-file download as its account ($text)', async ({ email, text }) => {
    const panel = renderPanel(ok({ listing: { kind: 'service-account', file: KEY_FILE, email: SA }, download: { kind: 'key-file', path: KEY_FILE.path, email } }), 'wizard');
    expect(await within(panel).findByText(text)).toBeDefined();
  });

  it('reports gcloud failing to name its configuration', async () => {
    const panel = renderPanel(ok({ listing: userListing({ status: 'known', email: 'alice@acme.com' }), download: { kind: 'cli-error', message: 'config is corrupt' } }), 'wizard');
    expect(await within(panel).findByText("gcloud couldn't report its configuration: config is corrupt")).toBeDefined();
  });

  it('sends a split GOOGLE_APPLICATION_CREDENTIALS file to the variable, which signing in again cannot change', async () => {
    const panel = renderPanel(ok({
      listing: userListing({ status: 'known', email: 'alice@acme.com' }, ENV_FILE),
      download: gcloud('admin@acme.com'),
      splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' },
    }), 'wizard');
    await waitFor(() => { expect(panel.textContent).toContain('Bucket access is signed in as alice@acme.com — to use admin@acme.com, fix or unset GOOGLE_APPLICATION_CREDENTIALS'); });
    expect(panel.textContent).not.toContain('gcloud auth application-default login');
  });

  it.each([
    { file: KEY_FILE, remedy: "check the provider's keyFile" },
    { file: ENV_FILE, remedy: 'fix or unset GOOGLE_APPLICATION_CREDENTIALS' },
  ])('sends an unreadable credential to its own remedy ($remedy)', async ({ file, remedy }) => {
    const panel = renderPanel(ok({ listing: { kind: 'unreadable', file }, download: gcloud('alice@acme.com') }), 'wizard');
    await waitFor(() => { expect(panel.textContent).toContain("Bucket access isn't signed in — "); });
    expect(panel.textContent).toContain(remedy);
  });
});
