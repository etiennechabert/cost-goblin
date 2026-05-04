import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DataManagement } from '../views/data-management.js';
import { SetupWizard } from '../views/setup-wizard.js';
import { ViewsEditor } from '../views/views-editor.js';

// ---------------------------------------------------------------------------
// Data Management — error states
// ---------------------------------------------------------------------------

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

describe('DataManagement error states', () => {
  it('shows SSO login error with refresh hint', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataInventory').mockRejectedValue(
      new Error('To authenticate, run: aws sso login --profile prod'),
    );
    renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getByText('To authenticate, run: aws sso login --profile prod')).toBeDefined();
    });
    expect(screen.getByText('Open SSO Login')).toBeDefined();
    expect(screen.getByText('A browser window will open. Refresh this page after logging in.')).toBeDefined();
  });

  it('shows permission denied error without refresh hint', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataInventory').mockRejectedValue(
      new Error('Access Denied: insufficient permissions for s3:ListBucket'),
    );
    renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getByText('Access Denied: insufficient permissions for s3:ListBucket')).toBeDefined();
    });
    expect(screen.queryByText('Refresh this page after logging in.')).toBeNull();
  });

  it('shows network timeout error', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataInventory').mockRejectedValue(
      new Error('NetworkError: request timed out after 30000ms'),
    );
    renderDataManagement(api);
    await waitFor(() => {
      expect(screen.getByText('NetworkError: request timed out after 30000ms')).toBeDefined();
    });
  });

  it('shows sync error in tier panel when sync fails', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'syncPeriods').mockRejectedValue(
      new Error('S3 bucket access denied'),
    );
    vi.spyOn(api, 'getDataInventory').mockResolvedValue({
      periods: [{ period: '2026-03', localStatus: 'missing', totalSize: 100, files: [{ key: 'data/2026-03/file.parquet', contentHash: 'abc', size: 100 }] }],
      totalRemoteSize: 100,
      totalLocalPeriods: 0,
      totalRemotePeriods: 1,
      local: { periods: [], diskBytes: 0, oldestPeriod: null, newestPeriod: null },
    });
    const { user } = renderDataManagement(api);

    await waitFor(() => {
      expect(screen.getByText('Mar 2026')).toBeDefined();
      expect(screen.getByText(/^Download 1/)).toBeDefined();
    });

    await user.click(screen.getByText(/^Download 1/));

    await waitFor(() => {
      expect(screen.getByText('S3 bucket access denied')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Setup Wizard — error and edge-case states
// ---------------------------------------------------------------------------

function renderWizard(props?: { source?: 'daily' | 'hourly' | 'costOptimization'; profile?: string }) {
  const api = new MockCostApi();
  const onComplete = vi.fn();
  const user = userEvent.setup();
  return {
    api,
    onComplete,
    user,
    ...render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} source={props?.source} profile={props?.profile} />
      </CostApiProvider>,
    ),
  };
}

describe('SetupWizard error states', () => {
  it('shows bucket listing error when listS3Buckets returns an error', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'listS3Buckets').mockResolvedValue({
      buckets: [],
      error: 'AccessDenied: unable to list S3 buckets',
    });
    const onComplete = vi.fn();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} source="daily" profile="default" />
      </CostApiProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('AccessDenied: unable to list S3 buckets')).toBeDefined();
    });
  });

  it('shows missing columns warning when CUR report lacks required columns', async () => {
    const { api, user } = renderWizard();
    vi.spyOn(api, 'browseS3').mockResolvedValue({
      prefixes: ['data', 'metadata'],
      isCurReport: true,
      detectedType: 'daily',
      missingColumns: ['line_item_usage_amount', 'pricing_public_on_demand_cost'],
    });

    await user.click(screen.getByText('Get Started'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));

    await waitFor(() => {
      expect(screen.getByText('Missing required columns')).toBeDefined();
    });
    expect(screen.getByText('line_item_usage_amount, pricing_public_on_demand_cost')).toBeDefined();
  });

  it('disables confirm button when folder is not a CUR report', async () => {
    const { api, user } = renderWizard();
    vi.spyOn(api, 'browseS3').mockResolvedValue({
      prefixes: ['some-folder'],
      isCurReport: false,
      detectedType: 'unknown',
      missingColumns: [],
    });

    await user.click(screen.getByText('Get Started'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));

    await waitFor(() => {
      expect(screen.getByText('Select a CUR folder')).toBeDefined();
    });
    const confirmButton = screen.getByText('Select a CUR folder').closest('button');
    expect(confirmButton?.disabled).toBe(true);
  });

  it('shows no profiles found message when AWS has no profiles', async () => {
    const { api, user } = renderWizard();
    vi.spyOn(api, 'listAwsProfiles').mockResolvedValue([]);

    await user.click(screen.getByText('Get Started'));
    await waitFor(() => {
      expect(screen.getByText('No AWS profiles found')).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Views Editor — save failure
// ---------------------------------------------------------------------------

describe('ViewsEditor error states', () => {
  it('shows error message when saving views fails', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'saveViewsConfig').mockRejectedValue(
      new Error('EACCES: permission denied, open views.yaml'),
    );
    render(
      <CostApiProvider value={api}>
        <ViewsEditor />
      </CostApiProvider>,
    );

    await waitFor(() => {
      expect(screen.getAllByText('Cost Overview').length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByText('+ New view'));
    fireEvent.click(screen.getByText('Save changes'));

    await waitFor(() => {
      expect(screen.getByText('EACCES: permission denied, open views.yaml')).toBeDefined();
    });
  });

  it('shows error when loading views config fails', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getViewsConfig').mockRejectedValue(
      new Error('Config file corrupted'),
    );
    render(
      <CostApiProvider value={api}>
        <ViewsEditor />
      </CostApiProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText('Config file corrupted')).toBeDefined();
    });
  });
});
