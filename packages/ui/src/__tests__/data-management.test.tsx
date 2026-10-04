import { act, render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { GCLOUD_ADC_LOGIN_COMMAND, asProviderName } from '@costgoblin/core/browser';
import type { ProviderConfig } from '@costgoblin/core/browser';
import { MOCK_GCP_PROVIDER, MOCK_MIXED_PROVIDER_CONFIG, MOCK_MULTI_PROVIDER_CONFIG, MockCostApi } from '../__fixtures__/mock-api.js';
import { DataManagement } from '../views/data-management.js';

function renderDataManagement(api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  const user = userEvent.setup();
  return {
    api: mockApi,
    user,
    ...render(
      <CostApiProvider value={mockApi}>
        <DataManagement />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('DataManagement', () => {
  it.each([
    { name: 'renders heading', text: 'Data Management' },
    { name: 'shows org sync prompt when not synced', text: 'AWS Organizations not synced' },
    { name: 'shows daily tier panel', text: 'Daily' },
  ])('$name', async ({ text }) => {
    renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText(text)).toBeDefined();
    });
  });

  it('shows hourly tier as not configured', async () => {
    renderDataManagement();
    await waitFor(() => {
      const elements = screen.getAllByText('Not configured');
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows cost optimization tier as not configured', async () => {
    renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText('Cost Optimization')).toBeDefined();
      const elements = screen.getAllByText('Not configured');
      expect(elements.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows no data source configured when config has no providers', async () => {
    const api = new MockCostApi();
    api.getConfig = () => Promise.reject(new Error('No config found'));
    renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getByText('No data source configured')).toBeDefined();
    });
  });

  it('refresh button triggers data reload', async () => {
    const api = new MockCostApi();
    const spy = vi.spyOn(api, 'getDataInventory');
    const { user } = renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeDefined();
    });
    const callsBefore = spy.mock.calls.length;
    await user.click(screen.getByText('Refresh'));
    await waitFor(() => {
      expect(spy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('delete all data button shows confirmation modal', async () => {
    const { user } = renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText('Delete All Data')).toBeDefined();
    });
    await user.click(screen.getByText('Delete All Data'));
    await waitFor(() => {
      expect(screen.getByText('Delete all local data')).toBeDefined();
    });
  });

  it('prune button is clickable even when nothing is outside retention', async () => {
    // Prune is an on-demand action: always clickable so the user can re-check
    // and remove anything outside retention. With nothing expired it opens the
    // confirmation rather than being inert.
    const { user } = renderDataManagement();
    const pruneBtn = await screen.findByRole('button', { name: /^Prune$/ });
    expect(pruneBtn).toHaveProperty('disabled', false);
    await user.click(pruneBtn);
    await waitFor(() => {
      expect(screen.getByText('Prune old data')).toBeDefined();
    });
  });

  it('prune button shows confirmation when data is outside retention', async () => {
    const api = new MockCostApi();
    // Daily retention in the mock config is 90 days; a 2020 period is well
    // outside it, so the Prune action should offer to remove it.
    api.getDataInventory = () => Promise.resolve({
      periods: [],
      totalRemoteSize: 0,
      totalLocalPeriods: 1,
      totalRemotePeriods: 0,
      lastSync: null,
      local: { periods: ['2020-01'], diskBytes: 1024, oldestPeriod: '2020-01', newestPeriod: '2020-01' },
    });
    const { user } = renderDataManagement(api);
    const pruneBtn = await screen.findByRole('button', { name: /Prune \(1\)/ });
    await user.click(pruneBtn);
    await waitFor(() => {
      expect(screen.getByText('Prune old data')).toBeDefined();
    });
  });

  it('confirming prune calls pruneNow and refreshes inventory', async () => {
    const api = new MockCostApi();
    api.getDataInventory = () => Promise.resolve({
      periods: [],
      totalRemoteSize: 0,
      totalLocalPeriods: 1,
      totalRemotePeriods: 0,
      lastSync: null,
      local: { periods: ['2020-01'], diskBytes: 1024, oldestPeriod: '2020-01', newestPeriod: '2020-01' },
    });
    const spy = vi.spyOn(api, 'pruneNow');
    const { user } = renderDataManagement(api);
    const pruneBtn = await screen.findByRole('button', { name: /Prune \(1\)/ });
    await user.click(pruneBtn);
    await user.click(await screen.findByRole('button', { name: /^Prune$/ }));
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('sync button is clickable even when all tiers are up to date', async () => {
    // Sync is on-demand: always clickable (except mid-sync) so a click re-checks
    // S3 and pulls anything new, rather than being hard-disabled off a possibly
    // stale snapshot.
    const api = new MockCostApi();
    const spy = vi.spyOn(api, 'getDataInventory');
    const { user } = renderDataManagement(api);
    const syncBtn = await screen.findByRole('button', { name: /^Sync$/ });
    expect(syncBtn).toHaveProperty('disabled', false);
    const callsBefore = spy.mock.calls.length;
    await user.click(syncBtn);
    // The click re-checks the configured tier(s) against S3.
    await waitFor(() => {
      expect(spy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('sync button shows count and syncs missing/stale periods on demand', async () => {
    const api = new MockCostApi();
    // A far-future period is always within the retention cutoff, and 'missing'
    // marks it as needing a sync — so the toolbar offers "Sync (1)".
    api.getDataInventory = () => Promise.resolve({
      periods: [
        {
          period: '2099-12',
          files: [{ key: 'cur/BILLING_PERIOD=2099-12/file.parquet', contentHash: 'h', size: 1 }],
          totalSize: 1,
          localStatus: 'missing',
        },
      ],
      totalRemoteSize: 1,
      totalLocalPeriods: 0,
      totalRemotePeriods: 1,
      lastSync: null,
      local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null },
    });
    const spy = vi.spyOn(api, 'syncPeriods');
    const { user } = renderDataManagement(api);
    const syncBtn = await screen.findByRole('button', { name: /Sync \(1\)/ });
    await user.click(syncBtn);
    // Only the daily tier is configured in the mock, so the on-demand sync
    // fans out to exactly one syncPeriods call.
    await waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  it('renders one section per provider with the two-provider config', async () => {
    const api = new MockCostApi();
    api.getConfig = () => Promise.resolve(MOCK_MULTI_PROVIDER_CONFIG);
    renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Provider aws-main' })).toBeDefined();
      expect(screen.getByRole('region', { name: 'Provider aws-secondary' })).toBeDefined();
    });
    // Each provider section carries its own credentials profile chip and its
    // own Change AWS Profile + Remove actions.
    expect(screen.getByText('secondary')).toBeDefined();
    expect(screen.getAllByText('Change AWS Profile')).toHaveLength(2);
    expect(screen.getAllByText('Remove')).toHaveLength(2);
  });

  it('hides the Remove action when only one provider is configured', async () => {
    renderDataManagement();
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Provider aws-main' })).toBeDefined();
    });
    expect(screen.queryByText('Remove')).toBeNull();
  });

  it('polls sync status with composite provider:tier ids and per-provider inventory', async () => {
    const api = new MockCostApi();
    api.getConfig = () => Promise.resolve(MOCK_MULTI_PROVIDER_CONFIG);
    const statusSpy = vi.spyOn(api, 'getSyncStatus');
    const inventorySpy = vi.spyOn(api, 'getDataInventory');
    renderDataManagement(api);
    await waitFor(() => {
      const statusIds = statusSpy.mock.calls.map(c => c[0]);
      expect(statusIds).toContain('aws-main:daily');
      expect(statusIds).toContain('aws-secondary:daily');
      const inventoryCalls = inventorySpy.mock.calls.map(c => `${String(c[0])}|${String(c[1])}`);
      expect(inventoryCalls).toContain('daily|aws-main');
      expect(inventoryCalls).toContain('daily|aws-secondary');
    });
  });

  it('remove flow confirms and calls removeProvider for that provider', async () => {
    const api = new MockCostApi();
    api.getConfig = () => Promise.resolve(MOCK_MULTI_PROVIDER_CONFIG);
    const removeSpy = vi.spyOn(api, 'removeProvider');
    const { user } = renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getAllByText('Remove')).toHaveLength(2);
    });
    const removeButtons = screen.getAllByText('Remove');
    const secondRemove = removeButtons[1];
    expect(secondRemove).toBeDefined();
    if (secondRemove === undefined) return;
    await user.click(secondRemove);
    await waitFor(() => {
      expect(screen.getByText('Remove provider "aws-secondary"')).toBeDefined();
    });
    // The modal's confirm button is also labeled Remove — the last one on screen.
    const confirmButtons = screen.getAllByRole('button', { name: 'Remove' });
    const confirm = confirmButtons.at(-1);
    if (confirm === undefined) return;
    await user.click(confirm);
    await waitFor(() => {
      expect(removeSpy).toHaveBeenCalledWith('aws-secondary');
    });
  });

  it('add provider opens the wizard in add mode', async () => {
    const { user } = renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText('Add Provider')).toBeDefined();
    });
    await user.click(screen.getByText('Add Provider'));
    // Add-mode wizard starts at the get-started hub.
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    expect(within(dialog).getByLabelText('Set up from AWS')).toBeDefined();
  });
});

// The wizard modals and the profile swap used to sit inside an
// aria-hidden="true" overlay, which hid them — controls included — from
// assistive tech, so none of these role queries could reach them.
describe('DataManagement — modal dialogs', () => {
  async function openAddProvider() {
    const rendered = renderDataManagement();
    const trigger = await screen.findByRole('button', { name: 'Add Provider' });
    await rendered.user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Add provider' });
    return { ...rendered, trigger, dialog };
  }

  it('Add Provider is a modal dialog whose Close button is named and dismisses it', async () => {
    const { user, dialog } = await openAddProvider();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Add provider' })).toBeNull(); });
  });

  it('moves focus into the dialog on open and returns it to the trigger on close', async () => {
    const { user, trigger, dialog } = await openAddProvider();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Add provider' })).toBeNull(); });
    expect(document.activeElement).toBe(trigger);
  });

  it('pulls focus that lands on the page behind back into the dialog', async () => {
    // aria-modal declares the page inert — Tab must not walk onto it.
    const { dialog } = await openAddProvider();
    act(() => { screen.getByRole('button', { name: 'Refresh' }).focus(); });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('ignores an Escape a nested layer already consumed, or one that cancels an IME composition', async () => {
    const { user } = await openAddProvider();
    // A layer above it (e.g. a Radix popover) handles Escape in the capture
    // phase and marks it consumed.
    const consume = (e: KeyboardEvent) => { e.preventDefault(); };
    document.addEventListener('keydown', consume, { capture: true });
    await user.keyboard('{Escape}');
    document.removeEventListener('keydown', consume, { capture: true });
    expect(screen.getByRole('dialog', { name: 'Add provider' })).toBeDefined();

    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); });
    expect(screen.getByRole('dialog', { name: 'Add provider' })).toBeDefined();
  });

  it('closes on a backdrop click but not on a click inside the wizard', async () => {
    const { user, dialog } = await openAddProvider();
    await user.click(within(dialog).getByText('Which cloud are you billing on?'));
    expect(screen.getByRole('dialog', { name: 'Add provider' })).toBeDefined();
    await user.click(within(dialog).getByTestId('modal-backdrop'));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Add provider' })).toBeNull(); });
  });

  it('Escape closes only the topmost dialog when the wizard opened the Import dialog', async () => {
    const { user, dialog } = await openAddProvider();
    await user.click(within(dialog).getByRole('button', { name: 'Import from a teammate' }));
    // The Import dialog renders inside the wizard (it is not portalled).
    await within(dialog).findByRole('dialog', { name: 'Import configuration' });

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Import configuration' })).toBeNull(); });
    expect(screen.getByRole('dialog', { name: 'Add provider' })).toBeDefined();

    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Add provider' })).toBeNull(); });
  });

  it('the tier gear opens a Configure dialog named for the tier and provider', async () => {
    const { user } = renderDataManagement();
    const section = await screen.findByRole('region', { name: 'Provider aws-main' });
    const gear = await within(section).findByTitle('Configure daily');
    await user.click(gear);
    const dialog = await screen.findByRole('dialog', { name: 'Configure daily data source for aws-main' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
  });

  it('Change AWS Profile opens a named dialog that Escape and Cancel dismiss', async () => {
    const { user } = renderDataManagement();
    const swap = await screen.findByRole('button', { name: 'Change AWS Profile' });

    await user.click(swap);
    const dialog = await screen.findByRole('dialog', { name: 'Change AWS Profile' });
    await within(dialog).findByRole('group', { name: 'AWS profiles' });
    await user.keyboard('{Escape}');
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Change AWS Profile' })).toBeNull(); });

    await user.click(swap);
    const reopened = await screen.findByRole('dialog', { name: 'Change AWS Profile' });
    await user.click(within(reopened).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Change AWS Profile' })).toBeNull(); });
  });
});

describe('DataManagement — GCP tier Configure', () => {
  it('offers Configure on an unconfigured GCP hourly tier, as on AWS', async () => {
    // It used to say "add a hourly section to costgoblin.yaml" — the only way
    // to add hourly to a GCP provider after setup.
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue({ ...MOCK_MIXED_PROVIDER_CONFIG, providers: [MOCK_GCP_PROVIDER] });
    renderDataManagement(api);
    const section = await screen.findByRole('region', { name: 'Provider gcp-main' });
    const configure = await within(section).findByRole('button', { name: 'Configure hourly data source' });
    await userEvent.setup().click(configure);
    // The wizard opens browsing the provider's own bucket.
    await waitFor(() => { expect(screen.getByText('costgoblin-focus-export')).toBeDefined(); });
  });
});

describe('DataManagement — Region Names', () => {
  it('is offered only alongside an AWS provider, whose SSM it reads', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue({ ...MOCK_MIXED_PROVIDER_CONFIG, providers: [MOCK_GCP_PROVIDER] });
    renderDataManagement(api);
    await screen.findByRole('region', { name: 'Provider gcp-main' });
    expect(screen.queryByText(/Region Names/)).toBeNull();
    cleanup();

    const mixed = new MockCostApi();
    vi.spyOn(mixed, 'getConfig').mockResolvedValue(MOCK_MIXED_PROVIDER_CONFIG);
    renderDataManagement(mixed);
    await waitFor(() => { expect(screen.getAllByText(/Region Names/).length).toBeGreaterThan(0); });
  });
  it('keeps names cached before the AWS provider was removed, with Clear', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue({ ...MOCK_MIXED_PROVIDER_CONFIG, providers: [MOCK_GCP_PROVIDER] });
    vi.spyOn(api, 'getRegionNamesInfo').mockResolvedValue({
      count: 1, syncedAt: '2026-10-01T00:00:00Z', lastError: null,
      regions: { 'eu-west-1': { longName: 'Europe (Ireland)', country: 'Ireland', continent: 'Europe' } },
    });
    renderDataManagement(api);
    await waitFor(() => { expect(screen.getByText('Region Names')).toBeDefined(); });
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Re-sync' })).toBeNull();
  });
});

describe('DataManagement — GCP "Signed in as" panel', () => {
  const SECOND_GCP: ProviderConfig = { ...MOCK_GCP_PROVIDER, name: asProviderName('gcp-second') };

  it('shows one panel per GCP provider, asked for by that provider s name', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(MOCK_MIXED_PROVIDER_CONFIG);
    renderDataManagement(api);
    const section = await screen.findByRole('region', { name: 'Provider gcp-main' });
    await waitFor(() => { expect(within(section).getByRole('region', { name: 'Signed in as (gcp-main)' })).toBeDefined(); });
    // AWS has one credential path, already named by its profile.
    const aws = screen.getByRole('region', { name: 'Provider aws-main' });
    expect(within(aws).queryByRole('region', { name: /^Signed in as/ })).toBeNull();
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toContain('gcp-main'); });
    expect(api.gcpIdentitiesRequestedFor).not.toContain('aws-main');
  });

  it('surfaces the provider s warning', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue(MOCK_MIXED_PROVIDER_CONFIG);
    api.gcpIdentitiesResult = {
      status: 'ok',
      identities: {
        listing: { kind: 'user', file: { path: '/adc.json', origin: 'well-known' }, account: { status: 'known', email: 'alice@acme.com' } },
        download: { kind: 'gcloud', account: 'admin@acme.com', configuration: 'default' },
        reader: null,
        splitAccounts: { listingAccount: 'alice@acme.com', downloadAccount: 'admin@acme.com' },
      },
    };
    renderDataManagement(api);
    const warning = await screen.findByRole('note', { name: 'Credential warning' });
    expect(warning.textContent).toContain('Downloads run as admin@acme.com, but bucket listing runs as alice@acme.com');
  });

  it('re-reads every GCP provider s identities when one section is retried — they are machine-wide', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue({ ...MOCK_MIXED_PROVIDER_CONFIG, providers: [MOCK_GCP_PROVIDER, SECOND_GCP] });
    vi.spyOn(api, 'getDataInventory').mockRejectedValue(new Error('Cloud Storage request failed: 503'));
    const { user } = renderDataManagement(api);
    await waitFor(() => { expect(screen.getAllByText('Retry')).toHaveLength(2); });
    await waitFor(() => {
      expect(api.gcpIdentitiesRequestedFor.filter(n => n === 'gcp-main')).toHaveLength(1);
      expect(api.gcpIdentitiesRequestedFor.filter(n => n === 'gcp-second')).toHaveLength(1);
    });
    const first = screen.getByRole('region', { name: 'Provider gcp-main' });
    await user.click(within(first).getByText('Retry'));
    await waitFor(() => {
      expect(api.gcpIdentitiesRequestedFor.filter(n => n === 'gcp-main')).toHaveLength(2);
      expect(api.gcpIdentitiesRequestedFor.filter(n => n === 'gcp-second')).toHaveLength(2);
    });
  });

  it('re-reads the identities when the credential poll heals the inventory on its own', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = new MockCostApi();
      vi.spyOn(api, 'getConfig').mockResolvedValue({ ...MOCK_MIXED_PROVIDER_CONFIG, providers: [MOCK_GCP_PROVIDER] });
      vi.spyOn(api, 'getDataInventory').mockRejectedValueOnce(new Error(`Google Cloud credentials expired. Run: ${GCLOUD_ADC_LOGIN_COMMAND}`));
      renderDataManagement(api);
      await waitFor(() => { expect(screen.getByText(/credentials expired/)).toBeDefined(); });
      await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(1); });
      // No Retry click: the 5s poll alone recovers the inventory.
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => { expect(screen.queryByText(/credentials expired/)).toBeNull(); });
      await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(2); });
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not re-run gcloud after a Prune, which cannot change who is signed in — only Refresh does', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getConfig').mockResolvedValue({ ...MOCK_MIXED_PROVIDER_CONFIG, providers: [MOCK_GCP_PROVIDER] });
    const { user } = renderDataManagement(api);
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(1); });
    const inventoryReads = vi.spyOn(api, 'getDataInventory');
    await user.click(screen.getByRole('button', { name: 'Prune' }));
    const confirm = screen.getAllByRole('button', { name: 'Prune' }).at(-1);
    if (confirm === undefined) throw new Error('no Prune confirmation');
    await user.click(confirm);
    // The prune's refresh reached the section (inventory re-read)...
    await waitFor(() => { expect(inventoryReads).toHaveBeenCalled(); });
    // ...but not the identities.
    expect(api.gcpIdentitiesRequestedFor).toHaveLength(1);
    // The header Refresh does re-read them.
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => { expect(api.gcpIdentitiesRequestedFor).toHaveLength(2); });
  });
});
