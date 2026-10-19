import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CostApi, OrgAccount, OrgSyncProgress, OrgSyncResult } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { OrgAccountsSection } from '../views/data-management-org.js';
import { deferred } from './deferred.js';

const ACCOUNTS: readonly OrgAccount[] = [
  {
    id: '111111111111', name: 'prod-main', email: 'prod@acme.com', status: 'ACTIVE',
    joinedTimestamp: '2024-01-15T10:00:00Z', ouPath: 'Root/Production', tags: { team: 'platform', env: 'prod' },
  },
  {
    id: '222222222222', name: 'sandbox', email: 'sandbox@acme.com', status: 'SUSPENDED',
    joinedTimestamp: '', ouPath: '', tags: {},
  },
  {
    id: '333333333333', name: 'data-dev', email: 'data@acme.com', status: 'ACTIVE',
    joinedTimestamp: '2025-03-01T00:00:00Z', ouPath: 'Root/Development', tags: { cost_center: 'cc-42' },
  },
];

const SYNCED: OrgSyncResult = { accounts: ACCOUNTS, orgId: 'o-acme123', syncedAt: '2026-10-01T08:00:00Z' };

type RegionInfo = Awaited<ReturnType<CostApi['getRegionNamesInfo']>>;

const REGIONS: RegionInfo = {
  count: 30,
  syncedAt: '2026-10-01T08:00:00Z',
  lastError: null,
  regions: { 'eu-west-1': { longName: 'Europe (Ireland)', country: 'IE', continent: 'Europe' } },
};

/** The mock answers "never synced"; these tests need a synced org, so they
 *  address it through the CostApi interface, whose methods can be replaced. */
function apiWith(org: OrgSyncResult | null, regions: RegionInfo = null): CostApi {
  const api: CostApi = new MockCostApi();
  api.getOrgSyncResult = () => Promise.resolve(org);
  api.getRegionNamesInfo = () => Promise.resolve(regions);
  return api;
}

function renderSection(api: CostApi, props: { profile?: string | null; providerName?: string; refreshToken?: number; onDataChanged?: () => void } = {}) {
  const user = userEvent.setup();
  const view = render(
    <CostApiProvider value={api}>
      <OrgAccountsSection
        profile={props.profile === undefined ? 'default' : props.profile}
        providerName={props.providerName}
        refreshToken={props.refreshToken}
        onDataChanged={props.onDataChanged}
      />
    </CostApiProvider>,
  );
  return { user, ...view };
}

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('OrgAccountsSection — before the first sync', () => {
  it('syncs the organization with the provider s profile and reports the account count', async () => {
    const api = apiWith(null);
    const sync = vi.spyOn(api, 'syncOrgAccounts').mockResolvedValue({ accounts: ACCOUNTS, orgId: 'o-acme123', syncedAt: '2026-10-01T08:00:00Z' });
    const onDataChanged = vi.fn();
    const { user } = renderSection(api, { providerName: 'aws-main', onDataChanged });

    expect(screen.getByText('AWS Organizations not synced')).toBeDefined();
    await user.click(screen.getByRole('button', { name: 'Sync from AWS Organizations' }));

    expect(sync).toHaveBeenCalledWith('default', 'aws-main');
    expect(await screen.findByText('Synced 3 accounts')).toBeDefined();
    expect(onDataChanged).toHaveBeenCalledTimes(1);
  });

  it('asks for an AWS profile instead of offering a sync it cannot run', () => {
    renderSection(apiWith(null), { profile: null });
    expect(screen.getByText('Configure an AWS profile first via the setup wizard.')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Sync from AWS Organizations' })).toBeNull();
  });

  it('shows the polled progress while syncing, then the failure, and offers the sync again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = apiWith(null);
    const pending = deferred<OrgSyncResult>();
    api.syncOrgAccounts = () => pending.promise;
    const progress: OrgSyncProgress = { phase: 'tags', done: 3, total: 12 };
    api.getOrgSyncProgress = () => Promise.resolve(progress);
    const { user } = renderSection(api);

    await user.click(screen.getByRole('button', { name: 'Sync from AWS Organizations' }));
    // Syncing: the button is gone until the run settles.
    expect(screen.queryByRole('button', { name: 'Sync from AWS Organizations' })).toBeNull();
    expect(screen.getByText('accounts')).toBeDefined();

    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(screen.getByText('tags')).toBeDefined();
    expect(screen.getByText('— 3/12')).toBeDefined();

    await act(async () => { pending.reject(new Error('AccessDenied: organizations:ListAccounts')); await Promise.resolve(); });
    expect(await screen.findByText('AccessDenied: organizations:ListAccounts')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sync from AWS Organizations' })).toBeDefined();
  });

  it('keeps the last progress when a poll answers nothing or fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = apiWith(null);
    const pending = deferred<OrgSyncResult>();
    api.syncOrgAccounts = () => pending.promise;
    // shouldAdvanceTime also moves the clock with real time, so a slow runner
    // can fit a third 500 ms poll in before the sync settles: it must get a
    // promise to chain on, not undefined.
    const poll = vi.fn<CostApi['getOrgSyncProgress']>()
      .mockResolvedValue(null)
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('ipc closed'));
    api.getOrgSyncProgress = poll;
    const { user } = renderSection(api);

    await user.click(screen.getByRole('button', { name: 'Sync from AWS Organizations' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('accounts')).toBeDefined();

    await act(async () => { pending.reject('throttled'); await Promise.resolve(); });
    expect(await screen.findByText('throttled')).toBeDefined();
  });
});

describe('OrgAccountsSection — a synced organization', () => {
  async function expand(user: ReturnType<typeof userEvent.setup>): Promise<void> {
    await user.click(await screen.findByRole('button', { name: /^AWS Organization/ }));
  }

  it('starts collapsed, then summarizes what the last sync pulled', async () => {
    const { user } = renderSection(apiWith(SYNCED, REGIONS));
    const toggle = await screen.findByRole('button', { name: /^AWS Organization/ });
    expect(toggle.textContent).toContain('▸');
    expect(screen.queryByText('3 accounts')).toBeNull();

    await expand(user);
    expect(toggle.textContent).toContain('▾');
    expect(screen.getByText('3 accounts')).toBeDefined();
    // Distinct non-empty OU paths: the sandbox account sits at the root.
    expect(screen.getByText('2 organizational units')).toBeDefined();
    expect(screen.getByText(/^3 tag keys/)).toBeDefined();
    expect(screen.getByText('30 region friendly names')).toBeDefined();
    expect(screen.getByText(`Synced ${new Date(SYNCED.syncedAt).toLocaleDateString()} · Org o-acme123`)).toBeDefined();
  });

  it('lists every account, with a dash for an account outside any OU, and the discovered tag keys', async () => {
    const { user } = renderSection(apiWith(SYNCED, REGIONS));
    await expand(user);
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(r => r.querySelector('td')?.textContent)).toEqual(['111111111111', '222222222222', '333333333333']);
    const sandbox = rows[1];
    if (sandbox === undefined) throw new Error('sandbox row missing');
    expect(within(sandbox).getByText('—')).toBeDefined();
    expect(within(sandbox).getByText('SUSPENDED')).toBeDefined();

    expect(screen.getByText('Discovered Tags')).toBeDefined();
    for (const key of ['cost_center', 'env', 'team']) expect(screen.getByText(key)).toBeDefined();
  });

  it('filters accounts by ID, name or OU path', async () => {
    const { user } = renderSection(apiWith(SYNCED, REGIONS));
    await expand(user);
    const search = screen.getByPlaceholderText('Search accounts...');
    const bodyRows = (): string[] => within(screen.getByRole('table')).getAllByRole('row').slice(1).map(r => r.querySelector('td')?.textContent ?? '');

    await user.type(search, 'DEVELOPMENT');
    expect(bodyRows()).toEqual(['333333333333']);

    await user.clear(search);
    await user.type(search, 'SANDBOX');
    expect(bodyRows()).toEqual(['222222222222']);

    await user.clear(search);
    await user.type(search, '1111');
    expect(bodyRows()).toEqual(['111111111111']);
  });

  it('opens an account s details on click, and closes them again', async () => {
    const { user } = renderSection(apiWith(SYNCED, REGIONS));
    await expand(user);

    await user.click(screen.getByText('prod-main'));
    expect(screen.getByRole('heading', { name: 'prod-main' })).toBeDefined();
    expect(screen.getByText('prod@acme.com')).toBeDefined();
    expect(screen.getByText(new Date('2024-01-15T10:00:00Z').toLocaleDateString())).toBeDefined();
    expect(screen.getByText('Tags (2)')).toBeDefined();
    expect(screen.getByText('platform')).toBeDefined();

    // A second click on the same row toggles the panel shut.
    await user.click(screen.getAllByText('prod-main')[0] ?? document.body);
    expect(screen.queryByRole('heading', { name: 'prod-main' })).toBeNull();

    // An account with no tags, no OU and no join date.
    await user.click(screen.getByText('sandbox'));
    const heading = screen.getByRole('heading', { name: 'sandbox' });
    const panel = heading.closest('div.border-t');
    if (!(panel instanceof HTMLElement)) throw new Error('detail panel missing');
    expect(within(panel).getByText('No tags')).toBeDefined();
    expect(within(panel).getAllByText('—')).toHaveLength(2);

    await user.click(within(panel).getByRole('button', { name: '✕' }));
    expect(screen.queryByRole('heading', { name: 'sandbox' })).toBeNull();
  });

  it('explains why region names are missing: a failed SSM step, or none synced yet', async () => {
    const failed = renderSection(apiWith(SYNCED, { count: 0, syncedAt: '', lastError: 'ssm:GetParametersByPath denied', regions: {} }));
    await expand(failed.user);
    expect(screen.getByText('region friendly names — ssm:GetParametersByPath denied')).toBeDefined();
    expect(screen.getByText('✗')).toBeDefined();
    cleanup();

    const never = renderSection(apiWith(SYNCED, null));
    await expand(never.user);
    expect(screen.getByText('region friendly names not synced (re-sync to populate)')).toBeDefined();
  });

  it('words each sync phase while re-syncing, with a count once it is known', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = apiWith(SYNCED, REGIONS);
    const pending = deferred<OrgSyncResult>();
    api.syncOrgAccounts = () => pending.promise;
    let progress: OrgSyncProgress = { phase: 'ous', done: 0, total: 0 };
    api.getOrgSyncProgress = () => Promise.resolve(progress);
    const { user } = renderSection(api);

    const resync = await screen.findByRole('button', { name: 'Re-sync' });
    await user.click(resync);
    expect(screen.getByText('Listing accounts')).toBeDefined();
    expect(resync).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Clear' })).toHaveProperty('disabled', true);

    const tick = async (): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(500); }); };
    await tick();
    expect(screen.getByText('Discovering organizational units')).toBeDefined();

    progress = { phase: 'tags', done: 0, total: 0 };
    await tick();
    expect(screen.getByText('Fetching tags')).toBeDefined();

    progress = { phase: 'tags', done: 4, total: 9 };
    await tick();
    expect(screen.getByText('Fetching tags from each account')).toBeDefined();
    expect(screen.getByText('— 4/9')).toBeDefined();

    progress = { phase: 'regions', done: 1, total: 1 };
    await tick();
    expect(screen.getByText('Fetching region friendly names from SSM')).toBeDefined();

    await act(async () => { pending.resolve(SYNCED); await Promise.resolve(); });
    await waitFor(() => { expect(screen.queryByText('Fetching region friendly names from SSM')).toBeNull(); });
    expect(resync).toHaveProperty('disabled', false);
  });

  it('offers no Re-sync without a profile, but still lets the cached data be cleared', async () => {
    renderSection(apiWith(SYNCED, REGIONS), { profile: null });
    expect(await screen.findByRole('button', { name: 'Clear' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Re-sync' })).toBeNull();
  });

  it('clears the org data only after confirming, then re-reads it and tells the host', async () => {
    const api = apiWith(SYNCED, REGIONS);
    const clear = vi.spyOn(api, 'clearOrgData');
    const reads = vi.spyOn(api, 'getOrgSyncResult');
    const onDataChanged = vi.fn();
    const { user } = renderSection(api, { onDataChanged });

    await user.click(await screen.findByRole('button', { name: 'Clear' }));
    const dialog = await screen.findByRole('dialog', { name: 'Clear AWS Org sync data?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(clear).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    const confirm = await screen.findByRole('dialog', { name: 'Clear AWS Org sync data?' });
    const readsBefore = reads.mock.calls.length;
    await user.click(within(confirm).getByRole('button', { name: 'Clear' }));
    await waitFor(() => { expect(clear).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(onDataChanged).toHaveBeenCalledTimes(1); });
    await waitFor(() => { expect(reads.mock.calls.length).toBeGreaterThan(readsBefore); });
  });

  it('re-reads the org data when another section bumps the refresh token', async () => {
    const api = apiWith(SYNCED, REGIONS);
    const reads = vi.spyOn(api, 'getOrgSyncResult');
    const view = renderSection(api, { refreshToken: 0 });
    await screen.findByRole('button', { name: /^AWS Organization/ });
    const before = reads.mock.calls.length;

    view.rerender(
      <CostApiProvider value={api}>
        <OrgAccountsSection profile="default" refreshToken={1} />
      </CostApiProvider>,
    );
    await waitFor(() => { expect(reads.mock.calls.length).toBeGreaterThan(before); });
  });

  it('drops the details of an account the refreshed data no longer has', async () => {
    const api = apiWith(SYNCED, REGIONS);
    let org: OrgSyncResult = SYNCED;
    api.getOrgSyncResult = () => Promise.resolve(org);
    const view = renderSection(api, { refreshToken: 0 });
    await expand(view.user);
    await view.user.click(screen.getByText('sandbox'));
    expect(screen.getByRole('heading', { name: 'sandbox' })).toBeDefined();

    // Another payer's sync replaced the merged lookups without this account.
    org = { ...SYNCED, accounts: ACCOUNTS.filter(a => a.id !== '222222222222') };
    view.rerender(
      <CostApiProvider value={api}>
        <OrgAccountsSection profile="default" refreshToken={1} />
      </CostApiProvider>,
    );
    expect(await screen.findByText('2 accounts')).toBeDefined();
    expect(screen.queryByText('sandbox')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'sandbox' })).toBeNull();
  });
});
