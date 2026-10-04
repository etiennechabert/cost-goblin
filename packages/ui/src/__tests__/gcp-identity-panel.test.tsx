import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
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

const ADC_PATH = '/Users/test/.config/gcloud/application_default_credentials.json';
const ADC: GcpCredentialFile = { path: ADC_PATH, origin: 'well-known' };
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const ALICE: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };

const user = (account: GcpAccountLookup = ALICE, file: GcpCredentialFile = ADC): GcpListingIdentity => ({ kind: 'user', file, account });
const gcloud = (account: string | null, configuration = 'default'): GcpDownloadIdentity => ({ kind: 'gcloud', account, configuration });

function ok(identities: Partial<GcpIdentities> & Pick<GcpIdentities, 'listing' | 'download'>): GcpIdentityResult {
  return { status: 'ok', identities: { reader: null, splitAccounts: null, ...identities } };
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

/** Both paths: behind Details when the panel is healthy (its one line repeats
 *  the account), the panel itself otherwise. */
function breakdown(panel: HTMLElement): HTMLElement {
  return panel.querySelector('details') ?? panel;
}

afterEach(cleanup);

describe('GcpIdentityPanel — Data Management', () => {
  it('shows both accounts, names its landmark after the provider, and warns about nothing when they agree', async () => {
    const { api, panel } = renderPanel(new MockCostApi().gcpIdentitiesResult, { providerName: 'gcp-main' });
    expect(screen.getByRole('region', { name: 'Signed in as (gcp-main)' })).toBe(panel);
    await waitFor(() => { expect(within(breakdown(panel)).getAllByText('alice@acme.com')).toHaveLength(2); });
    expect(within(breakdown(panel)).getByText(`Application Default Credentials · ${ADC_PATH}`)).toBeDefined();
    expect(within(breakdown(panel)).getByText('gcloud CLI · configuration "default"')).toBeDefined();
    expect(within(panel).queryByRole('note')).toBeNull();
    expect(api.gcpIdentitiesRequestedFor).toEqual(['gcp-main']);
  });

  it('is one line when nothing needs action, with both paths behind Details', async () => {
    const { panel } = renderPanel(ok({ listing: user(), download: gcloud('alice@acme.com'), reader: SA }));
    await waitFor(() => { expect(panel.querySelector('details')).not.toBeNull(); });
    expect(breakdown(panel).hasAttribute('open')).toBe(false);
    expect(panel.querySelector('p')?.textContent).toBe(`alice@acme.com · reads as ${SA}`);
    // Both paths impersonate the provider's reader.
    expect(within(breakdown(panel)).getAllByText(SA)).toHaveLength(2);
  });

  it('shows a reader minted from the login under an impersonated ADC file, not chained through it', async () => {
    const other = 'old-reader@acme-billing.iam.gserviceaccount.com';
    const { panel } = renderPanel(ok({ listing: { kind: 'impersonated', file: ADC, target: other }, download: gcloud('alice@acme.com'), reader: SA }));
    await waitFor(() => { expect(panel.querySelector('details')).not.toBeNull(); });
    const paths = breakdown(panel);
    expect(within(paths).getAllByText(SA)).toHaveLength(2);
    // The file's own account is not who listing runs as.
    expect(within(paths).queryByText(other)).toBeNull();
    expect(within(paths).getByText('your Google account')).toBeDefined();
  });

  it('warns when listing impersonates through ADC but downloads, with no reader, do not', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'impersonated', file: ADC, target: SA }, download: gcloud('alice@acme.com') }));
    const warning = await within(panel).findByRole('note', { name: 'Credential warning' });
    expect(warning.textContent).toBe(`Bucket listing reads as ${SA}, but downloads run as alice@acme.com. Add impersonateServiceAccount: ${SA} to this provider in costgoblin.yaml so both read as it.`);
    // Not collapsed: this needs action.
    expect(panel.querySelector('details')).toBeNull();
  });

  it('shows both paths open when something needs action', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: ADC }, download: gcloud('alice@acme.com'), reader: SA }));
    await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
    expect(panel.querySelector('details')).toBeNull();
  });

  it('warns when downloads and listing run as different people, with a fix that keeps downloads working', async () => {
    const { panel } = renderPanel(ok({
      listing: user(),
      download: gcloud('admin@acme.com', 'acme-admin'),
      splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' },
    }));
    const warning = await within(panel).findByRole('note', { name: 'Credential warning' });
    expect(warning.textContent).toContain('Downloads run as admin@acme.com, but bucket listing runs as alice@acme.com');
    expect(warning.textContent).toContain('gcloud config set account alice@acme.com');
    // `config set` alone breaks downloads for an account gcloud never signed in as.
    expect(warning.textContent).toContain('gcloud auth login alice@acme.com first');
  });

  it('shows an impersonated ADC as the service account listing runs as', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'impersonated', file: ADC, target: SA }, download: gcloud('alice@acme.com') }));
    // The paths, not the warning below them, which names it too.
    await waitFor(() => { expect(panel.querySelector('dl')).not.toBeNull(); });
    const paths = panel.querySelector('dl') ?? panel;
    expect(within(paths).getByText(SA)).toBeDefined();
    expect(within(paths).getByText(/Service account, impersonated/)).toBeDefined();
  });

  it('tells a signed-out user which command to run', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: ADC }, download: gcloud(null) }));
    await waitFor(() => { expect(within(breakdown(panel)).getByText('Not signed in')).toBeDefined(); });
    expect(within(breakdown(panel)).getByText('gcloud auth application-default login')).toBeDefined();
    expect(within(breakdown(panel)).getByText(`No file at ${ADC_PATH}`)).toBeDefined();
    expect(within(breakdown(panel)).getByText('No active gcloud account')).toBeDefined();
    expect(within(breakdown(panel)).getByText('gcloud auth login')).toBeDefined();
  });

  it('sends a GOOGLE_APPLICATION_CREDENTIALS user to the variable, which signing in cannot change', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: { path: '/old/key.json', origin: 'env' } }, download: gcloud('alice@acme.com') }));
    await waitFor(() => { expect(within(breakdown(panel)).getByText('Not signed in')).toBeDefined(); });
    expect(within(breakdown(panel)).getByText('Not signed in').parentElement?.textContent).toContain('fix or unset GOOGLE_APPLICATION_CREDENTIALS');
    expect(within(panel).queryByText('gcloud auth application-default login')).toBeNull();
  });

  it('describes an ADC user it could not name', async () => {
    const { panel } = renderPanel(ok({ listing: user({ status: 'unknown', reason: 'expired' }), download: { kind: 'cli-missing' } }));
    await waitFor(() => { expect(within(breakdown(panel)).getByText(/sign-in has expired/)).toBeDefined(); });
    expect(within(breakdown(panel)).getByText('The gcloud CLI is not installed — downloads need it')).toBeDefined();
  });

  it('shows a key-file provider as one service account for both halves', async () => {
    const keyFile: GcpCredentialFile = { path: '/keys/ci.json', origin: 'key-file' };
    const { panel } = renderPanel(ok({
      listing: { kind: 'service-account', file: keyFile, email: 'ci@acme.iam.gserviceaccount.com' },
      download: { kind: 'key-file', path: '/keys/ci.json', email: 'ci@acme.iam.gserviceaccount.com' },
    }));
    await waitFor(() => { expect(within(breakdown(panel)).getAllByText('ci@acme.iam.gserviceaccount.com')).toHaveLength(2); });
    expect(within(breakdown(panel)).getAllByText('Provider keyFile · /keys/ci.json')).toHaveLength(2);
  });

  it('reports when the identities cannot be checked', async () => {
    const { panel } = renderPanel({ status: 'unavailable', reason: '"aws-main" is not a Google Cloud provider.' });
    await waitFor(() => {
      expect(within(breakdown(panel)).getByText(`Couldn't check credentials: "aws-main" is not a Google Cloud provider.`)).toBeDefined();
    });
  });

  it('re-reads on Re-check', async () => {
    const { api, user: events, panel } = renderPanel(new MockCostApi().gcpIdentitiesResult);
    await waitFor(() => { expect(within(breakdown(panel)).getAllByText('alice@acme.com')).toHaveLength(2); });
    api.gcpIdentitiesResult = ok({ listing: user(), download: gcloud('carol@acme.com') });
    await events.click(within(panel).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => { expect(within(breakdown(panel)).getByText('carol@acme.com')).toBeDefined(); });
    expect(api.gcpIdentitiesRequestedFor).toHaveLength(2);
  });
});

describe('GcpIdentityPanel — wizard', () => {
  it('shows only the account gcloud is signed in as', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'impersonated', file: ADC, target: SA }, download: gcloud('admin@acme.com', 'acme-admin') }), { context: 'wizard' });
    await waitFor(() => { expect(within(breakdown(panel)).getByText('admin@acme.com')).toBeDefined(); });
    expect(panel.textContent).toContain('gcloud configuration "acme-admin"');
    expect(panel.textContent).not.toContain(SA);
  });

  it('adds one line when bucket access is signed in as someone else', async () => {
    const { panel } = renderPanel(ok({
      listing: user(),
      download: gcloud('admin@acme.com'),
      splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' },
    }), { context: 'wizard' });
    await waitFor(() => { expect(panel.textContent).toContain('Bucket access is signed in as alice@acme.com — a different account.'); });
  });

  it('says what to run when gcloud or bucket access is not signed in', async () => {
    const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: ADC }, download: gcloud(null) }), { context: 'wizard' });
    await waitFor(() => { expect(panel.textContent).toContain('gcloud isn\'t signed in — run gcloud auth login'); });
    expect(panel.textContent).toContain('Bucket access isn\'t signed in — run gcloud auth application-default login');
  });

  it('reports a missing CLI', async () => {
    const { panel } = renderPanel(ok({ listing: user(), download: { kind: 'cli-missing' } }), { context: 'wizard' });
    await waitFor(() => { expect(within(breakdown(panel)).getByText('The gcloud CLI is not installed')).toBeDefined(); });
  });
});
