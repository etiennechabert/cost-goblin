import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { SetupWizard } from '../views/setup-wizard.js';

function renderWizard(props?: { source?: 'daily' | 'hourly' | 'costOptimization'; profile?: string; api?: MockCostApi }) {
  const api = props?.api ?? new MockCostApi();
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

afterEach(cleanup);

describe('SetupWizard', () => {
  it('get started button advances to profile step', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByText('Get Started'));
    await waitFor(() => {
      expect(screen.getByText('default')).toBeDefined();
    });
    expect(screen.getByText('prod')).toBeDefined();
    expect(screen.getByText('staging')).toBeDefined();
  });

  it('shows loading state while fetching profiles', async () => {
    const api = new MockCostApi();
    let resolveProfiles: ((profiles: string[]) => void) | undefined;
    api.listAwsProfiles = () => new Promise<string[]>((resolve) => { resolveProfiles = resolve; });
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} />
      </CostApiProvider>,
    );
    await user.click(screen.getByText('Get Started'));
    expect(screen.getByText('Loading profiles...')).toBeDefined();
    resolveProfiles?.(['default']);
    await waitFor(() => {
      expect(screen.getByText('default')).toBeDefined();
    });
  });

  it('renders in source mode when source and profile provided', async () => {
    renderWizard({ source: 'daily', profile: 'default' });
    await waitFor(() => {
      expect(screen.getByText('my-cur-bucket')).toBeDefined();
    });
  });

  it('shows empty state when no AWS profiles found', async () => {
    const api = MockCostApi.withEmptyData();
    const { user } = renderWizard({ api });
    await user.click(screen.getByText('Get Started'));
    await waitFor(() => {
      expect(screen.getByText('No AWS profiles found')).toBeDefined();
    });
    expect(screen.getByText(/Configure credentials in/)).toBeDefined();
  });

  it('shows empty state when no S3 buckets found', async () => {
    const api = MockCostApi.withEmptyData();
    const { user } = renderWizard({ api });
    await user.click(screen.getByText('Get Started'));
    await waitFor(() => {
      expect(screen.queryByText('Loading profiles...')).toBeNull();
    });
    const nextButton = screen.getByText('Next');
    expect(nextButton.closest('button')?.disabled).toBe(true);
  });

  it('shows error message when bucket listing fails', async () => {
    const api = new MockCostApi();
    api.listS3Buckets = vi.fn().mockResolvedValue({ buckets: [], error: 'Access denied: insufficient permissions' });
    renderWizard({ source: 'daily', profile: 'default', api });
    await waitFor(() => {
      expect(screen.getByText('Access denied: insufficient permissions')).toBeDefined();
    });
  });

  it('shows loading state while fetching buckets', async () => {
    const api = new MockCostApi();
    let resolveBuckets: ((result: { buckets: { name: string; region: string }[]; error?: string }) => void) | undefined;
    api.listS3Buckets = () => new Promise<{ buckets: { name: string; region: string }[]; error?: string }>((resolve) => { resolveBuckets = resolve; });
    renderWizard({ source: 'daily', profile: 'default', api });
    expect(screen.getByText('Loading buckets...')).toBeDefined();
    resolveBuckets?.({ buckets: [{ name: 'test-bucket', region: 'us-east-1' }] });
    await waitFor(() => {
      expect(screen.getByText('test-bucket')).toBeDefined();
    });
  });

  it('shows loading state while browsing S3 folders', async () => {
    const api = new MockCostApi();
    let resolveBrowse: ((result: { prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }) => void) | undefined;
    api.browseS3 = () => new Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }>((resolve) => { resolveBrowse = resolve; });
    const { user } = renderWizard({ source: 'daily', profile: 'default', api });
    await waitFor(() => {
      expect(screen.getByText('my-cur-bucket')).toBeDefined();
    });
    await user.click(screen.getByText('my-cur-bucket'));
    expect(screen.getByText('Loading...')).toBeDefined();
    resolveBrowse?.({ prefixes: ['data', 'metadata'], isCurReport: true, detectedType: 'daily', missingColumns: [] });
    await waitFor(() => {
      expect(screen.getByText('data/')).toBeDefined();
    });
  });

  it('shows empty state when no folders found in S3 bucket', async () => {
    const api = MockCostApi.withEmptyData();
    const { user } = renderWizard({ api });
    await user.click(screen.getByText('Get Started'));
    await waitFor(() => {
      expect(screen.queryByText('Loading profiles...')).toBeNull();
    });
    api.listAwsProfiles = vi.fn().mockResolvedValue(['test-profile']);
    const profiles = await api.listAwsProfiles();
    expect(profiles.length).toBeGreaterThan(0);
  });

  it('disables confirm button when no CUR report detected', async () => {
    const api = new MockCostApi();
    api.browseS3 = vi.fn().mockResolvedValue({ prefixes: ['random-folder'], isCurReport: false, detectedType: 'unknown', missingColumns: [] });
    const { user } = renderWizard({ source: 'daily', profile: 'default', api });
    await waitFor(() => {
      expect(screen.getByText('my-cur-bucket')).toBeDefined();
    });
    await user.click(screen.getByText('my-cur-bucket'));
    await waitFor(() => {
      expect(screen.getByText('random-folder/')).toBeDefined();
    });
    const confirmButton = screen.getByText('Select a CUR folder');
    expect(confirmButton.closest('button')?.disabled).toBe(true);
  });

  it('shows missing columns warning when CUR report incomplete', async () => {
    const api = new MockCostApi();
    api.browseS3 = vi.fn().mockResolvedValue({ prefixes: ['data', 'metadata'], isCurReport: true, detectedType: 'daily', missingColumns: ['line_item_resource_id', 'resource_tags'] });
    const { user } = renderWizard({ source: 'daily', profile: 'default', api });
    await waitFor(() => {
      expect(screen.getByText('my-cur-bucket')).toBeDefined();
    });
    await user.click(screen.getByText('my-cur-bucket'));
    await waitFor(() => {
      expect(screen.getByText('Missing required columns')).toBeDefined();
    });
    expect(screen.getByText('line_item_resource_id, resource_tags')).toBeDefined();
  });

  it('renders welcome step with static content', () => {
    renderWizard();
    expect(screen.getByText('CostGoblin')).toBeDefined();
    expect(screen.getByText('Cloud cost visibility for your team')).toBeDefined();
    expect(screen.getByText('Get Started')).toBeDefined();
  });

  it('shows no loading indicator on welcome step', () => {
    renderWizard();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.queryByText('Loading profiles...')).toBeNull();
  });
});
