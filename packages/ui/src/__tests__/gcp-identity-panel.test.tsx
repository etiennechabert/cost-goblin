import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  GcpAccountLookup,
  GcpCredentialFile,
  GcpDownloadIdentity,
  GcpDownloadImpersonation,
  GcpDownloadPrincipal,
  GcpGcloudImpersonation,
  GcpGcloudImpersonationSetting,
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
/** Listing for a provider with a reader: minted from the ADC user.
 *  `adcTarget`: what a legacy impersonated ADC file names itself. */
const reader = (target: string, account: GcpAccountLookup = ALICE, adcTarget: string | null = null): GcpListingIdentity => ({
  kind: 'impersonated', file: ADC, target, source: { kind: 'user', account }, via: { kind: 'provider', adcTarget },
});
/** A legacy `--impersonate-service-account` ADC file on a provider without a reader. */
const legacy = (target: string, account: GcpAccountLookup = ALICE): GcpListingIdentity => ({
  kind: 'impersonated', file: ADC, target, source: { kind: 'user', account }, via: { kind: 'credential' },
});
const account = (email: string | null, fromEnv = false): GcpDownloadPrincipal => ({ kind: 'account', account: email, fromEnv });
const gcloud = (principal: GcpDownloadPrincipal, impersonate: GcpDownloadImpersonation | null = null, configuration = 'default'): GcpDownloadIdentity => (
  { kind: 'gcloud', principal, impersonate, configuration }
);
const viaProvider = (target: string): GcpDownloadImpersonation => ({ target, origin: 'provider' });
const viaGcloud = (target: string): GcpGcloudImpersonationSetting => ({ target, origin: 'gcloud-config', delegates: [] });
const SET_READER = (target: string): string => `add impersonateServiceAccount: ${target} to this provider in costgoblin.yaml — both halves then impersonate it`;

function ok(identities: Partial<GcpIdentities> & Pick<GcpIdentities, 'listing' | 'download'>): GcpIdentityResult {
  return { status: 'ok', identities: { adcLoginPath: null, gcloudImpersonation: null, warnings: [], notes: [], ...identities } };
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

  it('shows a provider s reader impersonated from the signed-in user', async () => {
    const { panel } = renderPanel(ok({ listing: reader(SA), download: gcloud(account('alice@acme.com'), viaProvider(SA)) }));
    await waitFor(() => { expect(within(panel).getAllByText(SA)).toHaveLength(2); });
    expect(within(panel).getAllByText('impersonating')).toHaveLength(2);
    expect(within(panel).getAllByText('alice@acme.com')).toHaveLength(2);
    expect(panel.textContent).toContain('This provider\'s read-only service account (impersonateServiceAccount), minted from your sign-in');
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
  });

  it('does not say the provider ignores an old sign-in that impersonates its own reader', async () => {
    const { panel } = renderPanel(ok({
      listing: reader(SA, { status: 'unknown', reason: 'not-recorded' }, SA),
      download: gcloud(account('alice@acme.com'), viaProvider(SA)),
    }));
    await waitFor(() => { expect(panel.textContent).toContain('impersonate this same account themselves'); });
    expect(panel.textContent).not.toContain('doesn\'t use that');
  });

  it('says a legacy impersonated ADC is unwrapped, not chained through, for a provider with a reader', async () => {
    const { panel } = renderPanel(ok({
      listing: reader(SA, { status: 'unknown', reason: 'not-recorded' }, OTHER_SA),
      download: gcloud(account('alice@acme.com'), viaProvider(SA)),
    }));
    await waitFor(() => { expect(within(panel).getAllByText(SA)).toHaveLength(2); });
    expect(panel.textContent).toContain(`Your Application Default Credentials impersonate ${OTHER_SA} themselves; this provider doesn't use that — it mints its reader from the sign-in underneath`);
  });

  it('says when listing impersonates through a legacy ADC file itself', async () => {
    const { panel } = renderPanel(ok({ listing: legacy(SA), download: gcloud(account('alice@acme.com'), viaGcloud(SA)) }));
    await waitFor(() => { expect(within(panel).getAllByText(SA)).toHaveLength(2); });
    expect(panel.textContent).toContain('Impersonated by the credential itself (an --impersonate-service-account sign-in) — this provider names no read-only service account');
  });

  describe('warnings', () => {
    it('gcloud s own impersonation setting disagreeing with a legacy ADC — fixed by naming a reader, never by unsetting alone', async () => {
      const { panel } = renderPanel(ok({
        listing: legacy(SA),
        download: gcloud(account('alice@acme.com'), viaGcloud(OTHER_SA)),
        warnings: [{ kind: 'target-mismatch', listingTarget: SA, gcloud: viaGcloud(OTHER_SA), advice: { kind: 'set-reader', target: SA } }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`Bucket listing impersonates ${SA} through your Application Default Credentials, but gcloud is set to impersonate ${OTHER_SA} (auth/impersonate_service_account)`);
      expect(text).toContain(`To read as one account, ${SET_READER(SA)}`);
      // Unsetting gcloud's side alone would leave downloads impersonating nothing.
      expect(text).not.toContain('gcloud config unset');
      expect(text).not.toContain('--impersonate-service-account');
      expect(text).not.toContain('setup wizard');
      expect(within(panel).getByText(/impersonation from gcloud's auth\/impersonate_service_account/)).toBeDefined();
    });

    it('gcloud impersonating on its own while listing does not', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('alice@acme.com'), viaGcloud(OTHER_SA)),
        warnings: [{ kind: 'listing-not-impersonated', gcloud: viaGcloud(OTHER_SA), advice: { kind: 'set-reader', target: OTHER_SA } }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`gcloud is set to impersonate ${OTHER_SA}`);
      expect(text).toContain(SET_READER(OTHER_SA));
      expect(text).toContain('If that setting isn\'t meant for CostGoblin, run gcloud config unset auth/impersonate_service_account');
    });

    it('tells an env-sourced impersonation to unset the variable, which `config unset` cannot beat', async () => {
      const fromEnv: GcpGcloudImpersonationSetting = { target: OTHER_SA, origin: 'env', delegates: [] };
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('alice@acme.com'), fromEnv),
        gcloudImpersonation: fromEnv,
        warnings: [{ kind: 'listing-not-impersonated', gcloud: fromEnv, advice: { kind: 'set-reader', target: OTHER_SA } }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('from CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT in CostGoblin\'s environment');
      expect(text).toContain('If that setting isn\'t meant for CostGoblin, unset CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT in CostGoblin\'s environment');
      expect(text).not.toContain('gcloud config unset');
      expect(within(panel).getByText(/impersonation from CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT/)).toBeDefined();
    });

    it('never offers a reader to a key-file provider, which cannot have both', async () => {
      const keyFile: GcpCredentialFile = { path: '/keys/ci.json', origin: 'key-file' };
      const { panel } = renderPanel(ok({
        listing: { kind: 'service-account', file: keyFile, email: 'ci@acme.iam.gserviceaccount.com' },
        download: gcloud({ kind: 'key-file', path: '/keys/ci.json', origin: 'provider', email: 'ci@acme.iam.gserviceaccount.com' }, viaGcloud(OTHER_SA)),
        warnings: [{ kind: 'listing-not-impersonated', gcloud: viaGcloud(OTHER_SA), advice: { kind: 'key-file-provider' } }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('bucket listing uses this provider\'s keyFile');
      expect(text).not.toContain('impersonateServiceAccount:');
    });

    it('never offers a reader that is not one: a delegation chain, a non-service-account, or what gcloud already is', async () => {
      const chain: GcpGcloudImpersonation = { target: SA, origin: 'gcloud-config', delegates: [OTHER_SA] };
      const first = renderPanel(ok({
        listing: user(),
        download: gcloud(account('alice@acme.com'), chain),
        warnings: [{ kind: 'listing-not-impersonated', gcloud: chain, advice: { kind: 'delegation-chain', target: SA, delegates: [OTHER_SA] } }],
      }));
      const chainText = await warningsOf(first.panel);
      expect(chainText).toContain(`through the delegation chain ${OTHER_SA} → ${SA}`);
      expect(chainText).toContain('naming the last hop alone would skip the others');
      expect(chainText).not.toContain('impersonateServiceAccount:');
      expect(within(first.panel).getByText(`Through the delegation chain ${OTHER_SA} → ${SA}`)).toBeDefined();
      cleanup();

      const odd = 'Weird@example.com';
      const second = renderPanel(ok({
        listing: legacy(odd),
        download: gcloud(account('alice@acme.com')),
        warnings: [{ kind: 'download-not-impersonated', listingTarget: odd, advice: { kind: 'not-a-reader', target: odd } }],
      }));
      const oddText = await warningsOf(second.panel);
      expect(oddText).toContain(`${odd} isn't a service-account address a provider can name`);
      expect(oddText).not.toContain('impersonateServiceAccount:');
      cleanup();

      const third = renderPanel(ok({
        listing: legacy(SA),
        download: gcloud(account(SA), viaGcloud(OTHER_SA)),
        warnings: [{ kind: 'target-mismatch', listingTarget: SA, gcloud: viaGcloud(OTHER_SA), advice: { kind: 'download-is-target', target: SA } }],
      }));
      const selfText = await warningsOf(third.panel);
      expect(selfText).toContain(`gcloud already authenticates as ${SA} itself`);
      expect(selfText).toContain('run gcloud config unset auth/impersonate_service_account — downloads then run as gcloud\'s own identity');
      expect(selfText).not.toContain('impersonateServiceAccount:');
    });

    it('a legacy impersonated ADC on a provider without a reader — name the reader, don t re-log ADC', async () => {
      const { panel } = renderPanel(ok({
        listing: legacy(SA),
        download: gcloud(account('alice@acme.com')),
        warnings: [{ kind: 'download-not-impersonated', listingTarget: SA, advice: { kind: 'set-reader', target: SA } }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain(`Bucket listing impersonates ${SA} through your Application Default Credentials, but this provider names no read-only service account`);
      expect(text).toContain(SET_READER(SA));
      expect(text).not.toContain('application-default login');
    });

    it('downloads and listing running as different people, both needing Token Creator on the reader', async () => {
      const { panel } = renderPanel(ok({
        listing: reader(SA),
        download: gcloud(account('admin@acme.com'), viaProvider(SA), 'acme-admin'),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadPrincipal: account('admin@acme.com'), sharedTarget: SA }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('Downloads run as admin@acme.com, but bucket listing runs as alice@acme.com');
      expect(text).toContain(`both need Service Account Token Creator on ${SA}`);
      expect(text).toContain('gcloud config set account alice@acme.com');
      // `config set` alone breaks downloads for an account gcloud never signed in as.
      expect(text).toContain('gcloud auth login alice@acme.com first');
      expect(text).not.toContain('project list');
      expect(within(panel).getByText('gcloud CLI · configuration "acme-admin"')).toBeDefined();
    });

    it('never tells a CLOUDSDK_CORE_ACCOUNT user to run `config set`, which cannot win', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('admin@acme.com', true)),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadPrincipal: account('admin@acme.com', true), sharedTarget: null }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('each needs its own access');
      expect(text).toContain('gcloud\'s account is set by CLOUDSDK_CORE_ACCOUNT');
      expect(text).not.toContain('gcloud config set account');
      expect(within(panel).getByText('account set by CLOUDSDK_CORE_ACCOUNT')).toBeDefined();
    });

    it('follows gcloud s precedence: a credential file override is unset, not outvoted by `config set account`', async () => {
      const override: GcpDownloadPrincipal = { kind: 'key-file', path: '/g.json', origin: 'gcloud-config', email: 'g@acme.iam.gserviceaccount.com' };
      const first = renderPanel(ok({
        listing: user(),
        download: gcloud(override),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'g@acme.iam.gserviceaccount.com', listingKeyFile: null, downloadPrincipal: override, sharedTarget: null }],
      }));
      const text = await warningsOf(first.panel);
      expect(text).toContain('run gcloud config unset auth/credential_file_override');
      expect(text).not.toContain('gcloud config set account');
      cleanup();

      const fromEnv: GcpDownloadPrincipal = { ...override, origin: 'env' };
      const second = renderPanel(ok({
        listing: user(),
        download: gcloud(fromEnv),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'g@acme.iam.gserviceaccount.com', listingKeyFile: null, downloadPrincipal: fromEnv, sharedTarget: null }],
      }));
      const envText = await warningsOf(second.panel);
      expect(envText).toContain('unset CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE in CostGoblin\'s environment');
      expect(envText).not.toContain('gcloud config unset');
      expect(within(second.panel).getByText('gcloud\'s auth/credential_file_override · /g.json · set by CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE')).toBeDefined();
    });

    it('points a service-account listing at keyFile, not at `config set`', async () => {
      const keyAdc: GcpCredentialFile = { path: '/keys/ci.json', origin: 'env' };
      const { panel } = renderPanel(ok({
        listing: { kind: 'service-account', file: keyAdc, email: 'ci@acme.iam.gserviceaccount.com' },
        download: gcloud(account('alice@acme.com')),
        warnings: [{ kind: 'split-accounts', listingAccount: 'ci@acme.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: keyAdc, downloadPrincipal: account('alice@acme.com'), sharedTarget: null }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('set keyFile: /keys/ci.json on this provider so both halves use it');
      expect(text).not.toContain('gcloud config set account');
    });

    it('moves a reader minted from a key ADC onto the user s own sign-in, never onto keyFile', async () => {
      const keyAdc: GcpCredentialFile = { path: '/keys/ci.json', origin: 'env' };
      const { panel } = renderPanel(ok({
        listing: { kind: 'impersonated', file: keyAdc, target: SA, source: { kind: 'service-account', email: 'ci@acme.iam.gserviceaccount.com' }, via: { kind: 'provider', adcTarget: null } },
        download: gcloud(account('alice@acme.com'), viaProvider(SA)),
        warnings: [{ kind: 'split-accounts', listingAccount: 'ci@acme.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: keyAdc, downloadPrincipal: account('alice@acme.com'), sharedTarget: SA }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('unset GOOGLE_APPLICATION_CREDENTIALS');
      expect(text).not.toContain('keyFile:');
    });

    it('moves a key in the well-known ADC file with the same sign-in remedy as everywhere else', async () => {
      const keyAdc: GcpCredentialFile = { path: ADC_PATH, origin: 'well-known' };
      const { panel } = renderPanel(ok({
        listing: { kind: 'impersonated', file: keyAdc, target: SA, source: { kind: 'service-account', email: 'ci@acme.iam.gserviceaccount.com' }, via: { kind: 'provider', adcTarget: null } },
        download: gcloud(account('alice@acme.com'), viaProvider(SA)),
        adcLoginPath: '/work/gcloud/application_default_credentials.json',
        gcloudImpersonation: viaGcloud(OTHER_SA),
        warnings: [{ kind: 'split-accounts', listingAccount: 'ci@acme.iam.gserviceaccount.com', downloadAccount: 'alice@acme.com', listingKeyFile: keyAdc, downloadPrincipal: account('alice@acme.com'), sharedTarget: SA }],
      }));
      const text = await warningsOf(panel);
      expect(text).toContain('run CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT= gcloud auth application-default login');
      expect(text).toContain('CLOUDSDK_CONFIG is set, so gcloud writes /work/gcloud/application_default_credentials.json');
    });

    it('shows every warning at once', async () => {
      const { panel } = renderPanel(ok({
        listing: legacy(OTHER_SA, { status: 'known', email: 'bob@corp.com' }),
        download: gcloud(account('alice@acme.com'), viaGcloud(SA)),
        warnings: [
          { kind: 'target-mismatch', listingTarget: OTHER_SA, gcloud: viaGcloud(SA), advice: { kind: 'set-reader', target: OTHER_SA } },
          { kind: 'split-accounts', listingAccount: 'bob@corp.com', downloadAccount: 'alice@acme.com', listingKeyFile: null, downloadPrincipal: account('alice@acme.com'), sharedTarget: null },
        ],
      }));
      const list = await within(panel).findByRole('list', { name: 'Credential warnings' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    });
  });

  describe('remedies', () => {
    it('tells a signed-out user to run the plain sign-in, even for a provider with a reader', async () => {
      const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: ADC }, download: gcloud(account('alice@acme.com'), viaProvider(SA)) }));
      await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
      expect(within(panel).getByText('gcloud auth application-default login')).toBeDefined();
      expect(panel.textContent).not.toContain('--impersonate-service-account');
      expect(within(panel).getByText(`No file at ${ADC_PATH}`)).toBeDefined();
    });

    it('blanks gcloud s own impersonation setting in the sign-in command, which a terminal would otherwise honour', async () => {
      const { panel } = renderPanel(ok({
        listing: { kind: 'not-signed-in', file: ADC },
        download: gcloud(account('alice@acme.com'), viaProvider(SA)),
        gcloudImpersonation: viaGcloud(OTHER_SA),
      }));
      await waitFor(() => { expect(within(panel).getByText('Not signed in')).toBeDefined(); });
      expect(within(panel).getByText('CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT= gcloud auth application-default login')).toBeDefined();
    });

    it('re-signs an expired sign-in for a provider with a reader with the plain login, on a line of its own', async () => {
      const { panel } = renderPanel(ok({ listing: reader(SA, { status: 'unknown', reason: 'expired' }, SA), download: gcloud(account('alice@acme.com'), viaProvider(SA)) }));
      await waitFor(() => { expect(within(panel).getByText(/sign-in has expired/)).toBeDefined(); });
      const command = within(panel).getByText('gcloud auth application-default login');
      expect(command.parentElement?.textContent).toBe('To sign in again, run gcloud auth application-default login.');
      // The account line itself carries no remedy, so nothing runs into "impersonating".
      expect(within(panel).getByText(/sign-in has expired/).textContent).toBe('a Google account whose sign-in has expired');
      expect(panel.textContent).not.toContain('--impersonate-service-account=');
    });

    it('never tells a reader-less provider on a legacy sign-in to sign in plainly — it would widen its access', async () => {
      const { panel } = renderPanel(ok({ listing: legacy(SA, { status: 'unknown', reason: 'expired' }), download: gcloud(account('alice@acme.com')) }));
      await waitFor(() => { expect(within(panel).getByText(/sign-in has expired/)).toBeDefined(); });
      const command = within(panel).getByText('gcloud auth application-default login');
      expect(command.parentElement?.textContent).toContain(`To sign in again, first add impersonateServiceAccount: ${SA} to this provider in costgoblin.yaml`);
      expect(command.parentElement?.textContent).toContain('a plain one would widen it to your own access; then run gcloud auth application-default login');
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

    it('sends an empty CLOUDSDK_CORE_ACCOUNT to the variable, not to a sign-in', async () => {
      const { panel } = renderPanel(ok({ listing: user(), download: gcloud(account(null, true)) }));
      await waitFor(() => { expect(within(panel).getByText('No active gcloud account')).toBeDefined(); });
      expect(panel.textContent).toContain('CLOUDSDK_CORE_ACCOUNT is set but empty — unset CLOUDSDK_CORE_ACCOUNT in CostGoblin\'s environment.');
      expect(within(panel).queryByText('gcloud auth login')).toBeNull();
    });
  });

  describe('in the wizard', () => {
    it('shows only the account gcloud is signed in as — impersonation is the provider s business', async () => {
      const { panel } = renderPanel(ok({
        listing: legacy(SA, { status: 'unknown', reason: 'not-recorded' }),
        download: gcloud(account('admin@acme.com'), null, 'acme-admin'),
        warnings: [{ kind: 'download-not-impersonated', listingTarget: SA, advice: { kind: 'set-reader', target: SA } }],
        notes: [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: null }],
      }), { context: 'wizard' });
      await waitFor(() => { expect(within(panel).getByText('admin@acme.com')).toBeDefined(); });
      expect(panel.textContent).toContain('gcloud configuration "acme-admin"');
      expect(panel.textContent).not.toContain(SA);
      expect(panel.textContent).not.toContain('impersonat');
      expect(within(panel).queryByRole('list')).toBeNull();
    });

    it('adds one line when bucket access is signed in as someone else', async () => {
      const { panel } = renderPanel(ok({
        listing: user(),
        download: gcloud(account('admin@acme.com')),
        warnings: [{ kind: 'split-accounts', listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com', listingKeyFile: null, downloadPrincipal: account('admin@acme.com'), sharedTarget: null }],
      }), { context: 'wizard' });
      await waitFor(() => { expect(panel.textContent).toContain('Bucket access is signed in as alice@acme.com — a different account.'); });
    });

    it('says what to run when gcloud or bucket access is not signed in', async () => {
      const { panel } = renderPanel(ok({ listing: { kind: 'not-signed-in', file: ADC }, download: gcloud(account(null)) }), { context: 'wizard' });
      await waitFor(() => { expect(panel.textContent).toContain('gcloud isn\'t signed in — run gcloud auth login'); });
      expect(panel.textContent).toContain('Bucket access isn\'t signed in — run gcloud auth application-default login');
    });

    it('reports a missing CLI', async () => {
      const { panel } = renderPanel(ok({ listing: user(), download: { kind: 'cli-missing' } }), { context: 'wizard' });
      await waitFor(() => { expect(within(panel).getByText('The gcloud CLI is not installed')).toBeDefined(); });
    });
  });

  it('names the legacy sign-in it cannot identify, and leaves the comparison to the user', async () => {
    const { panel } = renderPanel(ok({
      listing: reader(SA, { status: 'unknown', reason: 'not-recorded' }, OTHER_SA),
      download: gcloud(account('admin@acme.com'), viaProvider(SA)),
      notes: [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: SA }],
    }));
    await waitFor(() => { expect(within(panel).getByText(/the credential doesn't record which/)).toBeDefined(); });
    // A note, not a warning: nothing is known to be wrong.
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
    const notes = within(panel).getByRole('list', { name: 'Credential notes' });
    expect(notes.textContent).toContain('so this can\'t be checked: downloads run as admin@acme.com, which should be the account you signed in with');
    expect(notes.textContent).toContain(`needs permission to impersonate ${SA} too`);
    expect(notes.textContent).toContain('To record it, run gcloud auth application-default login.');
  });

  it('never tells a reader-less provider s note to re-sign in plainly — it names the reader first', async () => {
    const { panel } = renderPanel(ok({
      listing: legacy(SA, { status: 'unknown', reason: 'not-recorded' }),
      download: gcloud(account('admin@acme.com')),
      notes: [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: null }],
    }));
    const notes = await within(panel).findByRole('list', { name: 'Credential notes' });
    expect(notes.textContent).toContain(`To record it, first add impersonateServiceAccount: ${SA} to this provider in costgoblin.yaml`);
    expect(notes.textContent).not.toMatch(/To record it, run /);
  });

  it('routes the note s sign-in through the file s origin', async () => {
    const envFile: GcpCredentialFile = { path: '/keys/adc.json', origin: 'env' };
    const first = renderPanel(ok({
      listing: { kind: 'impersonated', file: envFile, target: SA, source: { kind: 'user', account: { status: 'unknown', reason: 'not-recorded' } }, via: { kind: 'provider', adcTarget: OTHER_SA } },
      download: gcloud(account('admin@acme.com'), viaProvider(SA)),
      notes: [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: SA }],
    }));
    const envNotes = await within(first.panel).findByRole('list', { name: 'Credential notes' });
    expect(envNotes.textContent).toContain('To record it, fix or unset GOOGLE_APPLICATION_CREDENTIALS');
    cleanup();

    const second = renderPanel(ok({
      listing: reader(SA, { status: 'unknown', reason: 'not-recorded' }, OTHER_SA),
      download: gcloud(account('admin@acme.com'), viaProvider(SA)),
      adcLoginPath: '/work/gcloud/application_default_credentials.json',
      notes: [{ kind: 'listing-account-unrecorded', downloadAccount: 'admin@acme.com', downloadTarget: SA }],
    }));
    const movedNotes = await within(second.panel).findByRole('list', { name: 'Credential notes' });
    expect(movedNotes.textContent).toContain('CLOUDSDK_CONFIG is set, so gcloud writes /work/gcloud/application_default_credentials.json');
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
    const { panel } = renderPanel(ok({ listing: user(), download: gcloud({ kind: 'access-token-file', path: '/tmp/token', origin: 'gcloud-config' }) }));
    await waitFor(() => { expect(within(panel).getByText(/a pre-minted access token/)).toBeDefined(); });
    expect(within(panel).getByText('gcloud\'s auth/access_token_file · /tmp/token')).toBeDefined();
  });

  it('says when gcloud runs on a token from CLOUDSDK_AUTH_ACCESS_TOKEN, or a token file set in the environment', async () => {
    const first = renderPanel(ok({ listing: user(), download: gcloud({ kind: 'access-token' }) }));
    await waitFor(() => { expect(within(first.panel).getByText(/a pre-minted access token/)).toBeDefined(); });
    expect(within(first.panel).getByText('CLOUDSDK_AUTH_ACCESS_TOKEN in CostGoblin\'s environment')).toBeDefined();
    cleanup();
    const second = renderPanel(ok({ listing: user(), download: gcloud({ kind: 'access-token-file', path: '/sandbox/token', origin: 'env' }) }));
    await waitFor(() => { expect(within(second.panel).getByText('gcloud\'s auth/access_token_file · /sandbox/token · set by CLOUDSDK_AUTH_ACCESS_TOKEN_FILE')).toBeDefined(); });
  });

  it('shows a key file that impersonates by itself on both halves, with nothing to warn about', async () => {
    const keyFile: GcpCredentialFile = { path: '/keys/legacy.json', origin: 'key-file' };
    const { panel } = renderPanel(ok({
      listing: { kind: 'impersonated', file: keyFile, target: SA, source: { kind: 'user', account: ALICE }, via: { kind: 'credential' } },
      download: gcloud({ kind: 'key-file', path: '/keys/legacy.json', origin: 'provider', email: null }, { origin: 'credential-file', target: SA, fileOrigin: 'provider' }),
    }));
    await waitFor(() => { expect(within(panel).getAllByText(SA)).toHaveLength(2); });
    expect(within(panel).getByText(/impersonation built into the credential file/)).toBeDefined();
    expect(within(panel).queryByRole('list', { name: 'Credential warnings' })).toBeNull();
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
