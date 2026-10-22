import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpIdentities,
  GcpIdentityResult,
  GcpListingIdentity,
  GcpSplitAccounts,
} from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { GcpIdentityPanel } from '../components/gcp-identity-panel.js';

const ADC_PATH = '/Users/test/.config/gcloud/application_default_credentials.json';
const ADC: GcpCredentialFile = { path: ADC_PATH, origin: 'well-known' };
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const ALICE: GcpAccountLookup = { status: 'known', email: 'alice@acme.com' };
const SPLIT: GcpSplitAccounts = { listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' };
/** A service account gcloud activated from a key; Compute Engine's default
 *  one, so the check isn't the reader address grammar. */
const CI_SA = '123456789-compute@developer.gserviceaccount.com';

const user = (account: GcpAccountLookup = ALICE, file: GcpCredentialFile = ADC): GcpListingIdentity => ({ kind: 'user', file, account });
const gcloud = (account: string | null, configuration = 'default'): GcpDownloadIdentity => ({ kind: 'gcloud', account, configuration });

function ok(identities: Partial<GcpIdentities> & Pick<GcpIdentities, 'listing' | 'download'>): GcpIdentityResult {
  return { status: 'ok', identities: { reader: null, splitAccounts: null, ...identities } };
}

function renderPanel(result: GcpIdentityResult, props: {
  providerName?: string;
  context?: 'wizard' | 'provider';
  onSplitAccounts?: (split: GcpSplitAccounts | null) => void;
} = {}) {
  const api = new MockCostApi();
  api.gcpIdentitiesResult = result;
  const userEvents = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <GcpIdentityPanel providerName={props.providerName} context={props.context ?? 'provider'} onSplitAccounts={props.onSplitAccounts} />
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

  it('warns when downloads and listing run as different people, with a fix in either direction', async () => {
    const { panel } = renderPanel(ok({
      listing: user(),
      download: gcloud('admin@acme.com', 'acme-admin'),
      splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' },
    }));
    const warning = await within(panel).findByRole('note', { name: 'Credential warning' });
    // Which account holds the grants is the user's to know: switching gcloud
    // alone moved downloads onto the listing account, the one without the
    // grant in a live case. And `config set` alone breaks downloads for an
    // account gcloud never signed in as.
    expect(warning.textContent).toBe(
      'Downloads run as admin@acme.com, but bucket listing runs as alice@acme.com — two different accounts, and each needs '
      + 'its own access. To use one account for both, sign bucket listing in as admin@acme.com: run gcloud auth '
      + 'application-default login — or switch downloads to alice@acme.com: run gcloud config set account alice@acme.com '
      + '(after gcloud auth login alice@acme.com if gcloud never signed in as it).',
    );
  });

  it('offers only the gcloud switch when downloads run as a service account, which no sign-in can be', async () => {
    const { panel } = renderPanel(ok({
      listing: user(),
      download: gcloud(CI_SA),
      splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: CI_SA },
    }));
    const warning = await within(panel).findByRole('note', { name: 'Credential warning' });
    expect(warning.textContent).toContain('To use one account for both, switch downloads to alice@acme.com: run gcloud config set account alice@acme.com');
    expect(warning.textContent).not.toContain('application-default login');
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

  it('adds one line when bucket access is signed in as someone else, with the sign-in that matches it to gcloud', async () => {
    // Toward gcloud's account: it is the one the wizard shows, and lists
    // projects as.
    const { panel } = renderPanel(ok({ listing: user(), download: gcloud('admin@acme.com'), splitAccounts: SPLIT }), { context: 'wizard' });
    await waitFor(() => {
      expect(panel.textContent).toContain('Bucket access is signed in as alice@acme.com — to use admin@acme.com, run gcloud auth application-default login');
    });
  });

  it('hands the split to the wizard once the check settles', async () => {
    const reported = vi.fn<(split: GcpSplitAccounts | null) => void>();
    renderPanel(ok({ listing: user(), download: gcloud('admin@acme.com'), splitAccounts: SPLIT }), { context: 'wizard', onSplitAccounts: reported });
    await waitFor(() => { expect(reported).toHaveBeenLastCalledWith(SPLIT); });
  });

  it('withdraws the split while it re-checks, so no refusal names an account that may have just changed', async () => {
    const reported = vi.fn<(split: GcpSplitAccounts | null) => void>();
    const { api, user: events, panel } = renderPanel(
      ok({ listing: user(), download: gcloud('admin@acme.com'), splitAccounts: SPLIT }),
      { context: 'wizard', onSplitAccounts: reported },
    );
    await waitFor(() => { expect(reported).toHaveBeenLastCalledWith(SPLIT); });
    vi.spyOn(api, 'getGcpIdentities').mockReturnValue(new Promise<GcpIdentityResult>(() => undefined));
    await events.click(within(panel).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => { expect(reported).toHaveBeenLastCalledWith(null); });
  });

  it('withdraws the split when a re-check cannot check the identities', async () => {
    const reported = vi.fn<(split: GcpSplitAccounts | null) => void>();
    const { api, user: events, panel } = renderPanel(
      ok({ listing: user(), download: gcloud('admin@acme.com'), splitAccounts: SPLIT }),
      { context: 'wizard', onSplitAccounts: reported },
    );
    await waitFor(() => { expect(reported).toHaveBeenLastCalledWith(SPLIT); });
    api.gcpIdentitiesResult = { status: 'unavailable', reason: 'gcloud timed out' };
    await events.click(within(panel).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => { expect(panel.textContent).toContain("Couldn't check credentials: gcloud timed out"); });
    expect(reported).toHaveBeenLastCalledWith(null);
  });

  it('offers no browser sign-in when gcloud runs as a service account, which one cannot be', async () => {
    const { panel } = renderPanel(ok({
      listing: user(),
      download: gcloud(CI_SA),
      splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: CI_SA },
    }), { context: 'wizard' });
    await waitFor(() => { expect(panel.textContent).toContain('Bucket access is signed in as alice@acme.com — a different account.'); });
    expect(panel.textContent).not.toContain('application-default login');
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
