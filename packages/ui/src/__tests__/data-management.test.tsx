import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MOCK_MULTI_PROVIDER_CONFIG, MockCostApi } from '../__fixtures__/mock-api.js';
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
    await waitFor(() => {
      expect(screen.getByLabelText('Set up from AWS')).toBeDefined();
    });
  });
});
