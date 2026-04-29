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

  describe('loading states', () => {
    it('shows loading message when fetching inventory', async () => {
      const api = new MockCostApi();
      let resolveInventory: ((value: unknown) => void) | undefined;
      const inventoryPromise = new Promise(resolve => {
        resolveInventory = resolve;
      });
      api.getDataInventory = () => inventoryPromise as Promise<never>;
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Checking S3 for available data...')).toBeDefined();
      });
      if (resolveInventory !== undefined) {
        resolveInventory(null);
      }
    });
  });

  describe('error states', () => {
    it('shows error message when inventory fetch fails', async () => {
      const api = new MockCostApi();
      api.getDataInventory = () => Promise.reject(new Error('Failed to list S3 objects'));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Failed to list S3 objects')).toBeDefined();
      });
    });

    it('shows helpful message for aws sso login error', async () => {
      const api = new MockCostApi();
      api.getDataInventory = () => Promise.reject(new Error('Please run: aws sso login --profile default'));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Please run: aws sso login --profile default')).toBeDefined();
        expect(screen.getByText('Refresh this page after logging in.')).toBeDefined();
      });
    });

    it('shows network error message', async () => {
      const api = new MockCostApi();
      api.getDataInventory = () => Promise.reject(new Error('Network error: Connection timed out'));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Network error: Connection timed out')).toBeDefined();
      });
    });

    it('shows permission error message', async () => {
      const api = new MockCostApi();
      api.getDataInventory = () => Promise.reject(new Error('Access Denied: Insufficient permissions'));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Access Denied: Insufficient permissions')).toBeDefined();
      });
    });

    it('shows error when config fetch fails', async () => {
      const api = new MockCostApi();
      api.getConfig = () => Promise.reject(new Error('Configuration file not found'));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('No data source configured')).toBeDefined();
      });
    });

    it('handles very long error messages gracefully', async () => {
      const api = new MockCostApi();
      const longError = 'Error: '.concat('x'.repeat(500));
      api.getDataInventory = () => Promise.reject(new Error(longError));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText(longError)).toBeDefined();
      });
    });
  });

  describe('empty states', () => {
    it('shows not configured for all tiers when config has empty providers', async () => {
      const api = new MockCostApi();
      api.getConfig = () => Promise.resolve({
        providers: [],
        defaults: { periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 },
      });
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Data Management')).toBeDefined();
        const notConfiguredElements = screen.getAllByText('Not configured');
        expect(notConfiguredElements.length).toBeGreaterThanOrEqual(3);
      });
    });

    it('shows setup wizard option when not configured', async () => {
      const api = new MockCostApi();
      api.getConfig = () => Promise.reject(new Error('No config found'));
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Option 1: Run the wizard')).toBeDefined();
        expect(screen.getByText('Option 2: Manual setup')).toBeDefined();
      });
    });

    it('shows scaffold config button when not configured', async () => {
      const api = new MockCostApi();
      api.getConfig = () => Promise.reject(new Error('No config found'));
      const scaffoldSpy = vi.spyOn(api, 'scaffoldConfig');
      const { user } = renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Generate config templates & open folder')).toBeDefined();
      });
      await user.click(screen.getByText('Generate config templates & open folder'));
      await waitFor(() => {
        expect(scaffoldSpy).toHaveBeenCalled();
      });
    });

    it('shows not configured state for all tiers when no buckets configured', async () => {
      const api = new MockCostApi();
      api.getConfig = () => Promise.resolve({
        providers: [{
          name: 'aws-main',
          type: 'aws',
          credentials: { profile: 'default' },
          sync: {
            daily: { bucket: null as never, retentionDays: 365 },
            intervalMinutes: 60,
          },
        }],
        defaults: { periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 },
      });
      renderDataManagement(api);
      await waitFor(() => {
        const notConfiguredElements = screen.getAllByText('Not configured');
        expect(notConfiguredElements.length).toBeGreaterThanOrEqual(2);
      });
    });
  });

  describe('edge cases', () => {
    it('handles null inventory gracefully', async () => {
      const api = new MockCostApi();
      api.getDataInventory = () => Promise.resolve(null as never);
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Data Management')).toBeDefined();
      });
    });

    it('handles empty periods list', async () => {
      const api = new MockCostApi();
      api.getDataInventory = () => Promise.resolve({
        periods: [],
        totalRemoteSize: 0,
        totalLocalPeriods: 0,
        totalRemotePeriods: 0,
        local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null },
      });
      renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Daily')).toBeDefined();
      });
    });

    it('shows change aws profile button', async () => {
      renderDataManagement();
      await waitFor(() => {
        expect(screen.getByText('Change AWS Profile')).toBeDefined();
      });
    });

    it('shows auto-sync toggle', async () => {
      renderDataManagement();
      await waitFor(() => {
        expect(screen.getByText('Auto-sync')).toBeDefined();
      });
    });

    it('shows open folder button', async () => {
      const api = new MockCostApi();
      const openFolderSpy = vi.spyOn(api, 'openDataFolder');
      const { user } = renderDataManagement(api);
      await waitFor(() => {
        expect(screen.getByText('Open Folder')).toBeDefined();
      });
      await user.click(screen.getByText('Open Folder'));
      await waitFor(() => {
        expect(openFolderSpy).toHaveBeenCalled();
      });
    });
  });
});
