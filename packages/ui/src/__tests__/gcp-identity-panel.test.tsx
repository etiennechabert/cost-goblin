import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpIdentities,
  GcpIdentityResult,
  GcpListingIdentity,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { GcpIdentityPanel } from '../components/gcp-identity-panel.js';

const ADC_PATH = '/Users/test/.config/gcloud/application_default_credentials.json';
const ADC: GcpCredentialFile = { path: ADC_PATH, origin: 'well-known' };
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const OTHER_SA = 'company-reader@corp.iam.gserviceaccount.com';
const ALICE: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };

const user = (account: GcpAccountLookup = ALICE, file: GcpCredentialFile = ADC): GcpListingIdentity => ({ kind: 'user', file, account });
const impersonated = (target: string, account: GcpAccountLookup = ALICE): GcpListingIdentity => ({
  kind: 'impersonated', file: ADC, target, source: { kind: 'user', account },
});
const account = (email: string | null, fromEnv = false): GcpDownloadPrincipal => ({ kind: 'account', account: email, fromEnv });
const gcloud = (principal: GcpDownloadPrincipal, impersonate: GcpDownloadImpersonation | null = null, configuration = 'default'): GcpDownloadIdentity => (
  { kind: 'gcloud', principal, impersonate, configuration }
);
const viaProvider = (target: string): GcpDownloadImpersonation => ({ target, origin: 'provider' });
const viaGcloud = (target: string): GcpDownloadImpersonation => ({ target, origin: 'gcloud-config' });

function ok(identities: Partial<GcpIdentities> & Pick<GcpIdentities, 'listing' | 'download'>): GcpIdentityResult {
  return { status: 'ok', identities: { adcLoginPath: null, warnings: [], notes: [], ...identities } };
}

function renderPanel(result: GcpIdentityResult, props: { providerName?: string; context?: 'wizard' | 'provider' } = {}) {
  const api = new MockCostApi();
  api.gcpIdentitiesResult = result;
  const userEvents = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <GcpIdentityPanel providerName={props.providerName} context={props.context ?? 'provider'} />
    </CostApiProvider>,
  );
  return { api, user: userEvents, panel: screen.getByRole('region', { name: /^Signed in as/ }) };
}

async function warningsOf(panel: HTMLElement): Promise<string> {
  const list = await within(panel).findByRole('list', { name: 'Credential warnings' });
  return list.textContent;
}

afterEach(cleanup);

describe('GcpIdentityPanel', () => {
  it('shows both identities, names its landmark after the provider, and warns about nothing when they agree', async () => {
    const { api, panel } = renderPanel(new MockCostApi().gcpIdentitiesResult, { providerName: 'gcp-main' });
    expect(screen.getByRole('region', { name: 'Signed in as (gcp-main)' })).toBe(panel);
    await waitFor(() => { expect(within(panel).getAllByText('alice@acme.com')).toHaveLength(2); });
    expect(within(panel).getByText(`Application Default Credentials · ${ADC_PATH}`)).toBeDefined();
    expect(within(panel).getByText('gcloud CLI · configuration "default"')).toBeDefined();
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
    expect(api.gcpIdentitiesRequestedFor).toEqual(['gcp-main']);
  });

  it('names the human and the service account of an impersonated ADC', async () => {
    const { panel } = renderPanel(ok({ listing: impersonated(SA), download: gcloud(account('alice@acme.com'), viaProvider(SA)) }));
    await waitFor(() => { expect(within(panel).getAllByText(SA)).toHaveLength(2); });
    expect(within(panel).getAllByText('impersonating')).toHaveLength(2);
  });

  describe('warnings', () => {
    it('ADC impersonating a different service account than the provider', async () => {
      const { panel } = renderPanel(ok({
        listing: impersonated(OTHER_SA),
        download: gcloud(account('alice@acme.com'), viaProvider(SA)),
        warnings: [{ kind: 'target-mismatch', listingTarget: OTHER_SA, download: viaProvider(SA) }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`Bucket listing impersonates ${OTHER_SA}, but this provider downloads as ${SA}`);
      expect(text).toContain(`gcloud auth application-default login --impersonate-service-account=${SA}`);
      // The machine-wide side effect is spelled out — re-pointing ADC is how
      // the other provider broke in the first place.
      expect(text).toContain(`any other provider relying on ${OTHER_SA} will switch too`);
    });

    it('gcloud s own impersonation setting overriding what listing uses', async () => {
      const { panel } = renderPanel(ok({
        listing: impersonated(SA),
        download: gcloud(account('alice@acme.com'), viaGcloud(OTHER_SA)),
        warnings: [{ kind: 'target-mismatch', listingTarget: SA, download: viaGcloud(OTHER_SA) }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`gcloud is set to impersonate ${OTHER_SA} (auth/impersonate_service_account)`);
      expect(text).toContain('gcloud config unset auth/impersonate_service_account');
      expect(text).toContain(`impersonateServiceAccount: ${SA} on this provider — it takes precedence`);
      expect(within(panel).getByText(/impersonation from gcloud's auth\/impersonate_service_account/)).toBeDefined();
    });

    it('a provider that impersonates when ADC does not', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('alice@acme.com'), viaProvider(SA)),
        warnings: [{ kind: 'listing-not-impersonated', download: viaProvider(SA) }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`This provider downloads as ${SA}, but bucket listing doesn't impersonate it`);
      expect(text).toContain(`--impersonate-service-account=${SA}`);
    });

    it('gcloud impersonating on its own while listing does not', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('alice@acme.com'), viaGcloud(OTHER_SA)),
        warnings: [{ kind: 'listing-not-impersonated', download: viaGcloud(OTHER_SA) }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`gcloud is set to impersonate ${OTHER_SA}`);
      expect(text).toContain('If that setting isn\'t meant for CostGoblin, run gcloud config unset auth/impersonate_service_account');
    });

    it('ADC impersonating while downloads do not — and what to add where', async () => {
      const result = ok({
        listing: impersonated(SA),
        download: gcloud(account('alice@acme.com')),
        warnings: [{ kind: 'download-not-impersonated', listingTarget: SA }],
      });
      const { panel } = renderPanel(result);
      const text = await warningsOf(panel);
      expect(text).toContain(`Bucket listing impersonates ${SA}, but downloads don't impersonate anything`);
      expect(text).toContain(`Add impersonateServiceAccount: ${SA} to the provider in costgoblin.yaml`);
      cleanup();
      const wizard = renderPanel(result, { context: 'wizard' });
      expect(await warningsOf(wizard.panel)).toContain(`The wizard doesn't set this, so after setup add impersonateServiceAccount: ${SA}`);
    });

    it('downloads and listing running as different people', async () => {
      const { panel } = renderPanel(ok({
        listing: impersonated(SA),
        download: gcloud(account('admin@acme.com'), viaProvider(SA), 'acme-admin'),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadAccountFromEnv: false }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('Downloads run as admin@acme.com, but bucket listing runs as alice@acme.com');
      expect(text).toContain('gcloud config set account alice@acme.com');
      // `config set` alone breaks downloads for an account gcloud never signed in as.
      expect(text).toContain('gcloud auth login alice@acme.com first');
      expect(text).not.toContain('project list');
      expect(within(panel).getByText('gcloud CLI · configuration "acme-admin"')).toBeDefined();
    });

    it('explains the project-list trap in the wizard', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('admin@acme.com')),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadAccountFromEnv: false }],
      }), { context: 'wizard' });
      const text = await warningsOf(panel);
      expect(text).toContain('Downloads and the project list run as admin@acme.com');
      expect(text).toContain('switch it back before syncing');
      expect(within(panel).getByText('Downloads & projects')).toBeDefined();
    });

    it('never tells a CLOUDSDK_CORE_ACCOUNT user to run `config set`, which cannot win', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('admin@acme.com', true)),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadAccountFromEnv: true }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('gcloud\'s account is set by CLOUDSDK_CORE_ACCOUNT');
      expect(text).not.toContain('gcloud config set account');
      expect(within(panel).getByText('account set by CLOUDSDK_CORE_ACCOUNT')).toBeDefined();
    });

    it('points a service-account listing at keyFile, not at `config set`', async () => {
      const keyAdc: GcpCredentialFile = { path: '/keys/ci.json', origin: 'env' };
      const { panel } = renderPanel(ok({
        listing: { kind: 'service-account', file: keyAdc, email: 'ci@acme.iam.gserviceaccount.com' },
        download: gcloud(account('alice@acme.com')),
        warnings: [{ kind: 'split-accounts', listingAccount: 'ci@acme.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: '/keys/ci.json', downloadAccountFromEnv: false }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('set keyFile: /keys/ci.json on this provider so both halves use it');
      expect(text).not.toContain('gcloud config set account');
    });

    it('shows every warning at once', async () => {
      const { panel } = renderPanel(ok({
        listing: impersonated(OTHER_SA, { status: 'known', email: 'bob@corp.com' }),
        download: gcloud(account('alice@acme.com'), viaProvider(SA)),
        warnings: [
          { kind: 'target-mismatch', listingTarget: OTHER_SA, download: viaProvider(SA) },
          { kind: 'split-accounts', listingAccount: 'bob@corp.com', downloadAccount: 'alice@acme.com', listingKeyFile: null, downloadAccountFromEnv: false },
        ],
      }));
      const list = await within(panel).findByRole('list', { name: 'Credential warnings' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    });
  });

  describe('remedies', () => {
    it('keeps the impersonation flag when telling a signed-out user to sign in', async () => {
      const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: ADC }, download: gcloud(account('alice@acme.com'), viaProvider(SA)) }));
      await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
      expect(within(panel).getByText(`gcloud auth application-default login --impersonate-service-account=${SA}`)).toBeDefined();
      expect(within(panel).getByText(`No file at ${ADC_PATH}`)).toBeDefined();
    });

    it('re-mints an expired impersonated sign-in with the same target, never as a plain user', async () => {
      const { panel } = renderPanel(ok({ listing: impersonated(SA, { status: 'unknown', reason: 'expired' }), download: gcloud(account('alice@acme.com')) }));
      await waitFor(() => { expect(within(panel).getByText(/sign-in has expired/)).toBeDefined(); });
      expect(within(panel).getByText(`gcloud auth application-default login --impersonate-service-account=${SA}`)).toBeDefined();
    });

    it('offers a bare sign-in when nothing impersonates', async () => {
      const { panel } = renderPanel(ok({ listing: user({ status: 'unknown', reason: 'expired' }), download: gcloud(account('alice@acme.com')) }));
      await waitFor(() => { expect(within(panel).getByText('gcloud auth application-default login')).toBeDefined(); });
    });

    it('sends a GOOGLE_APPLICATION_CREDENTIALS user to the variable, which signing in cannot change', async () => {
      const file: GcpCredentialFile = { path: '/old/key.json', origin: 'env' };
      const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file }, download: gcloud(account('alice@acme.com')) }));
      await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
      const row = within(panel).getByText('Not signed in').parentElement;
      expect(row?.textContent).toContain('fix or unset GOOGLE_APPLICATION_CREDENTIALS');
      expect(within(panel).queryByText('gcloud auth application-default login')).toBeNull();
    });

    it('explains when CLOUDSDK_CONFIG makes gcloud sign in somewhere CostGoblin does not read', async () => {
      const { panel } = renderPanel(ok({
        listing: { kind: 'not-signed-in', file: ADC },
        download: gcloud(account('alice@acme.com')),
        adcLoginPath: '/work/gcloud/application_default_credentials.json',
      }));
      await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
      const row = within(panel).getByText('Not signed in').parentElement;
      expect(row?.textContent).toContain('CLOUDSDK_CONFIG is set, so gcloud writes /work/gcloud/application_default_credentials.json, which CostGoblin doesn\'t read');
    });

    it('puts the gcloud sign-in on its own line, apart from what downloads impersonate', async () => {
      const { panel } = renderPanel(ok({ listing: user(), download: gcloud(account(null), viaProvider(SA)) }));
      await waitFor(() => { expect(within(panel).getByText('No active gcloud account')).toBeDefined(); });
      const command = within(panel).getByText('gcloud auth login');
      expect(command.parentElement?.textContent).toBe('Run gcloud auth login to sign gcloud in.');
    });
  });

  it('names the impersonated sign-in it cannot identify, and leaves the comparison to the user', async () => {
    const { panel } = renderPanel(ok({
      listing: impersonated(SA, { status: 'unknown', reason: 'not-recorded' }),
      download: gcloud(account('admin@acme.com'), viaProvider(SA)),
      notes: [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: SA }],
    }));
    await waitFor(() => { expect(within(panel).getByText(/the credential doesn't record which/)).toBeDefined(); });
    // A note, not a warning: nothing is known to be wrong.
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
    const notes = within(panel).getByRole('list', { name: 'Credential notes' });
    expect(notes.textContent).toContain('so this can\'t be checked: downloads run as admin@acme.com, which should be the account you signed in with');
    expect(notes.textContent).toContain(`needs permission to impersonate ${SA} too`);
  });

  it('shows a key-file provider as one service account for both halves', async () => {
    const keyFile: GcpCredentialFile = { path: '/keys/ci.json', origin: 'key-file' };
    const { panel } = renderPanel(ok({
      listing: { kind: 'service-account', file: keyFile, email: 'ci@acme.iam.gserviceaccount.com' },
      download: gcloud({ kind: 'key-file', path: '/keys/ci.json', origin: 'provider', email: 'ci@acme.iam.gserviceaccount.com' }),
    }));
    await waitFor(() => { expect(within(panel).getAllByText('ci@acme.iam.gserviceaccount.com')).toHaveLength(2); });
    expect(within(panel).getAllByText('Provider keyFile · /keys/ci.json')).toHaveLength(2);
  });

  it('says when gcloud runs on a pre-minted token it cannot name', async () => {
    const { panel } = renderPanel(ok({ listing: user(), download: gcloud({ kind: 'access-token-file', path: '/tmp/token' }) }));
    await waitFor(() => { expect(within(panel).getByText(/a pre-minted access token/)).toBeDefined(); });
    expect(within(panel).getByText('gcloud\'s auth/access_token_file · /tmp/token')).toBeDefined();
  });

  it('reports a missing CLI and an unusable credential', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'unrecognized', file: ADC, type: 'mystery' },
      download: { kind: 'cli-missing' },
    }));
    await waitFor(() => { expect(within(panel).getByText('The gcloud CLI is not installed — downloads need it')).toBeDefined(); });
    expect(within(panel).getByText('A credential the Cloud Storage SDK can\'t use (mystery)')).toBeDefined();
  });

  it('reports when the identities cannot be checked', async () => {
    const { panel } = renderPanel({ status: 'unavailable', reason: '"aws-main" is not a Google Cloud provider.' });
    await waitFor(() => {
      expect(within(panel).getByText(`Couldn't check credentials: "aws-main" is not a Google Cloud provider.`)).toBeDefined();
    });
  });

  it('re-reads on Re-check', async () => {
    const { api, user: events, panel } = renderPanel(new MockCostApi().gcpIdentitiesResult);
    await waitFor(() => { expect(within(panel).getAllByText('alice@acme.com')).toHaveLength(2); });
    api.gcpIdentitiesResult = ok({ listing: user(), download: gcloud(account('carol@acme.com')) });
    await events.click(within(panel).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => { expect(within(panel).getByText('carol@acme.com')).toBeDefined(); });
    expect(api.gcpIdentitiesRequestedFor).toHaveLength(2);
  });
});
