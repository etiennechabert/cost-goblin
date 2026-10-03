import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { GcpIdentities, GcpIdentityResult } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { GcpIdentityPanel } from '../components/gcp-identity-panel.js';

const ADC = '/Users/test/.config/gcloud/application_default_credentials.json';
const SA = 'costgoblin-reader@acme-billing.iam.gserviceaccount.com';
const OTHER_SA = 'company-reader@corp.iam.gserviceaccount.com';

function ok(identities: Omit<GcpIdentities, 'notes'>, notes: GcpIdentities['notes'] = []): GcpIdentityResult {
  return { status: 'ok', identities: { ...identities, notes } };
}

function renderPanel(result: GcpIdentityResult, props: { providerName?: string; context?: 'wizard' | 'provider' } = {}) {
  const api = new MockCostApi();
  api.gcpIdentitiesResult = result;
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <GcpIdentityPanel providerName={props.providerName} context={props.context ?? 'provider'} />
    </CostApiProvider>,
  );
  return { api, user, panel: screen.getByRole('region', { name: 'Signed in as' }) };
}

afterEach(cleanup);

describe('GcpIdentityPanel', () => {
  it('shows both identities and no warnings when they agree', async () => {
    const { api, panel } = renderPanel(new MockCostApi().gcpIdentitiesResult, { providerName: 'gcp-main' });
    await waitFor(() => { expect(within(panel).getAllByText('alice@acme.com')).toHaveLength(2); });
    expect(within(panel).getByText(`Application Default Credentials · ${ADC}`)).toBeDefined();
    expect(within(panel).getByText('gcloud CLI · configuration "default"')).toBeDefined();
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
    expect(api.gcpIdentitiesRequestedFor).toEqual(['gcp-main']);
  });

  it('names the human and the service account of an impersonated ADC', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'impersonated', credentialsPath: ADC, target: SA, source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } } },
      download: { kind: 'gcloud', account: 'alice@acme.com', configuration: 'default', impersonate: SA },
      warnings: [],
    }));
    await waitFor(() => { expect(within(panel).getAllByText(SA)).toHaveLength(2); });
    expect(within(panel).getAllByText('impersonating')).toHaveLength(2);
  });

  it('warns when ADC impersonates a different service account than the provider', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'impersonated', credentialsPath: ADC, target: OTHER_SA, source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } } },
      download: { kind: 'gcloud', account: 'alice@acme.com', configuration: 'default', impersonate: SA },
      warnings: [{ kind: 'adc-target-mismatch', adcTarget: OTHER_SA, providerTarget: SA }],
    }));
    const warnings = await within(panel).findByRole('list', { name: 'Credential warnings' });
    expect(warnings.textContent).toContain(`Bucket listing uses ${OTHER_SA}, but this provider downloads as ${SA}`);
    expect(warnings.textContent).toContain(`gcloud auth application-default login --impersonate-service-account=${SA}`);
    // The machine-wide side effect is spelled out — re-pointing ADC is how
    // the other provider broke in the first place.
    expect(warnings.textContent).toContain(`any other provider relying on ${OTHER_SA} will switch too`);
  });

  it('warns when the provider impersonates but ADC does not', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'user', credentialsPath: ADC, account: { status: 'known', email: 'alice@acme.com' } },
      download: { kind: 'gcloud', account: 'alice@acme.com', configuration: 'default', impersonate: SA },
      warnings: [{ kind: 'adc-not-impersonated', providerTarget: SA }],
    }));
    const warnings = await within(panel).findByRole('list', { name: 'Credential warnings' });
    expect(warnings.textContent).toContain(`This provider is set to use ${SA}, but Application Default Credentials don't impersonate it`);
    expect(warnings.textContent).toContain(`--impersonate-service-account=${SA}`);
  });

  it('warns when downloads and listing run as different accounts', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'impersonated', credentialsPath: ADC, target: SA, source: { kind: 'user', account: { status: 'known', email: 'alice@acme.com' } } },
      download: { kind: 'gcloud', account: 'admin@acme.com', configuration: 'acme-admin', impersonate: SA },
      warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' }],
    }));
    const warnings = await within(panel).findByRole('list', { name: 'Credential warnings' });
    expect(warnings.textContent).toContain('Downloads run as admin@acme.com, but bucket listing runs as alice@acme.com');
    expect(warnings.textContent).toContain('gcloud config set account alice@acme.com');
    expect(warnings.textContent).not.toContain('project list');
    expect(within(panel).getByText('gcloud CLI · configuration "acme-admin"')).toBeDefined();
  });

  it('explains the project-list trap in the wizard', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'user', credentialsPath: ADC, account: { status: 'known', email: 'alice@acme.com' } },
      download: { kind: 'gcloud', account: 'admin@acme.com', configuration: 'default', impersonate: null },
      warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' }],
    }), { context: 'wizard' });
    const warnings = await within(panel).findByRole('list', { name: 'Credential warnings' });
    expect(warnings.textContent).toContain('Downloads and the project list run as admin@acme.com');
    expect(warnings.textContent).toContain('switch it back before syncing');
    expect(within(panel).getByText('Downloads & projects')).toBeDefined();
  });

  it('shows every warning at once', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'impersonated', credentialsPath: ADC, target: OTHER_SA, source: { kind: 'user', account: { status: 'known', email: 'bob@corp.com' } } },
      download: { kind: 'gcloud', account: 'alice@acme.com', configuration: 'default', impersonate: SA },
      warnings: [
        { kind: 'adc-target-mismatch', adcTarget: OTHER_SA, providerTarget: SA },
        { kind: 'split-accounts', listingAccount: 'bob@corp.com', downloadAccount: 'alice@acme.com' },
      ],
    }));
    const warnings = await within(panel).findByRole('list', { name: 'Credential warnings' });
    expect(within(warnings).getAllByRole('listitem')).toHaveLength(2);
  });

  it('tells a signed-out user which command to run', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'not-signed-in', credentialsPath: ADC },
      download: { kind: 'gcloud', account: null, configuration: 'default', impersonate: null },
      warnings: [],
    }));
    await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
    expect(within(panel).getByText('gcloud auth application-default login')).toBeDefined();
    expect(within(panel).getByText(`No file at ${ADC}`)).toBeDefined();
    expect(within(panel).getByText('No active gcloud account')).toBeDefined();
    expect(within(panel).getByText('gcloud auth login')).toBeDefined();
  });

  it('describes an expired ADC sign-in it could not name', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'user', credentialsPath: ADC, account: { status: 'unknown', reason: 'expired' } },
      download: { kind: 'cli-missing' },
      warnings: [],
    }));
    await waitFor(() => { expect(within(panel).getByText(/sign-in has expired/)).toBeDefined(); });
    expect(within(panel).getByText('The gcloud CLI is not installed')).toBeDefined();
  });

  it('shows a key-file provider as one service account for both halves', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'service-account', credentialsPath: '/keys/ci.json', email: 'ci@acme.iam.gserviceaccount.com', origin: 'key-file' },
      download: { kind: 'key-file', keyFile: '/keys/ci.json', email: 'ci@acme.iam.gserviceaccount.com' },
      warnings: [],
    }));
    await waitFor(() => { expect(within(panel).getAllByText('ci@acme.iam.gserviceaccount.com')).toHaveLength(2); });
    expect(within(panel).getAllByText('Service account key · /keys/ci.json')).toHaveLength(2);
  });

  it('names the impersonated sign-in it cannot identify, and leaves the comparison to the user', async () => {
    const { panel } = renderPanel(ok({
      listing: { kind: 'impersonated', credentialsPath: ADC, target: SA, source: { kind: 'user', account: { status: 'unknown', reason: 'not-recorded' } } },
      download: { kind: 'gcloud', account: 'admin@acme.com', configuration: 'default', impersonate: SA },
      warnings: [],
    }, [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', target: SA }]));
    await waitFor(() => { expect(within(panel).getByText(/the credential doesn't record which/)).toBeDefined(); });
    // A note, not a warning: nothing is known to be wrong.
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
    const notes = within(panel).getByRole('list', { name: 'Credential notes' });
    expect(notes.textContent).toContain('so this can\'t be checked: downloads run as admin@acme.com, which should be the account you signed in with');
    expect(notes.textContent).toContain(`needs permission to impersonate ${SA} too`);
  });

  it('reports when the identities cannot be checked', async () => {
    const { panel } = renderPanel({ status: 'unavailable', reason: '"aws-main" is not a Google Cloud provider.' });
    await waitFor(() => {
      expect(within(panel).getByText(`Couldn't check credentials: "aws-main" is not a Google Cloud provider.`)).toBeDefined();
    });
  });

  it('re-reads on Re-check', async () => {
    const { api, user, panel } = renderPanel(new MockCostApi().gcpIdentitiesResult);
    await waitFor(() => { expect(within(panel).getAllByText('alice@acme.com')).toHaveLength(2); });
    api.gcpIdentitiesResult = ok({
      listing: { kind: 'user', credentialsPath: ADC, account: { status: 'known', email: 'alice@acme.com' } },
      download: { kind: 'gcloud', account: 'carol@acme.com', configuration: 'default', impersonate: null },
      warnings: [],
    });
    await user.click(within(panel).getByRole('button', { name: 'Re-check' }));
    await waitFor(() => { expect(within(panel).getByText('carol@acme.com')).toBeDefined(); });
    expect(api.gcpIdentitiesRequestedFor).toHaveLength(2);
  });
});
