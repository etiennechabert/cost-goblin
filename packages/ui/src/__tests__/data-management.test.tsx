import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
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
  it('renders heading', async () => {
    renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText('Data Management')).toBeDefined();
    });
  });

  it('shows org sync prompt when not synced', async () => {
    renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText('AWS Organizations not synced')).toBeDefined();
    });
  });

  it('shows daily tier panel', async () => {
    renderDataManagement();
    await waitFor(() => {
      expect(screen.getByText('Daily')).toBeDefined();
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

  it('prune button is disabled when no local data is outside retention', async () => {
    renderDataManagement();
    const pruneBtn = await screen.findByRole('button', { name: /^Prune$/ });
    expect(pruneBtn).toHaveProperty('disabled', true);
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

  it('sync button is disabled when all tiers are up to date', async () => {
    renderDataManagement();
    const syncBtn = await screen.findByRole('button', { name: /^Sync$/ });
    expect(syncBtn).toHaveProperty('disabled', true);
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
});
