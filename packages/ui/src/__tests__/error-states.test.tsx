import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { ErrorBoundary } from '../components/error-boundary.js';
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
  // The sync-error test spies on the global Date.now; restore between tests so
  // it can't leak into the others.
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows SSO login error with refresh hint', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'getDataInventory').mockRejectedValue(
      new Error('To authenticate, run: aws sso login --profile prod'),
    );
    renderDataManagement(api);
    // The error message renders as soon as the inventory query rejects, but the
    // SSO button is gated on a second query (awsProfile) also resolving. Assert
    // each with findByText so the button/hint wait for that later commit rather
    // than racing it — the synchronous getByText was flaky on slow CI runners.
    expect(await screen.findByText('To authenticate, run: aws sso login --profile prod')).toBeDefined();
    expect(await screen.findByText('Open SSO Login')).toBeDefined();
    expect(await screen.findByText('A browser window will open. Refresh this page after logging in.')).toBeDefined();
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
    // The download list only includes periods within the tier's retention
    // window (mock daily retentionDays = 90). Pin the clock near the fixture's
    // '2026-03' period so it stays in-window; otherwise this time-bombs once
    // wall-clock time advances >90 days past March 2026.
    vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-03-15T00:00:00Z').getTime());
    const api = new MockCostApi();
    vi.spyOn(api, 'syncPeriods').mockRejectedValue(
      new Error('S3 bucket access denied'),
    );
    vi.spyOn(api, 'getDataInventory').mockResolvedValue({
      periods: [{ period: '2026-03', localStatus: 'missing', totalSize: 100, files: [{ key: 'data/2026-03/file.parquet', contentHash: 'abc', size: 100 }] }],
      totalRemoteSize: 100,
      totalLocalPeriods: 0,
      totalRemotePeriods: 1,
      lastSync: null,
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

    await user.click(screen.getByText('Set up from S3'));
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

    await user.click(screen.getByText('Set up from S3'));
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

    await user.click(screen.getByText('Set up from S3'));
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

// ---------------------------------------------------------------------------
// Error Boundary — crash fallback
// ---------------------------------------------------------------------------

function Boom(): never {
  throw new Error('kaboom');
}

describe('ErrorBoundary fallback', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // The fallback replaces the whole tree, including the app header that hosts
  // the macOS window drag region — so it needs its own, or a crashed window
  // can't be moved (same trap as issue #317).
  it('fallback screen is a window drag region and the card opts out', () => {
    // React logs the caught error via console.error; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { container } = render(<ErrorBoundary><Boom /></ErrorBoundary>);
    expect(screen.getByText('Something went wrong')).toBeDefined();
    expect(container.firstElementChild?.className).toContain('[-webkit-app-region:drag]');
    expect(container.querySelector('[class*="[-webkit-app-region:no-drag]"]')).not.toBeNull();
  });
});
