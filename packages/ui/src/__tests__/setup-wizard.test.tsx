import type { CheckConfigBeaconParams, CheckConfigBeaconResult } from '@costgoblin/core/browser';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { SetupWizard } from '../views/setup-wizard.js';

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

  it('continues to manual browsing when the bucket has no published config', async () => {
    const { api, user } = renderWizard();
    const beaconSpy = vi.spyOn(api, 'checkConfigBeacon');
    await user.click(screen.getByText('Get Started'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));
    // Default mock beacon answer is 'none' → manual prefix browsing.
    await waitFor(() => { expect(screen.getAllByText('data/').length).toBeGreaterThan(0); });
    expect(beaconSpy).toHaveBeenCalledWith({ profile: 'default', bucket: 'my-cur-bucket' });
  });

  it('offers a discovered team configuration and applies it with the chosen profile', async () => {
    const { api, user, onComplete } = renderWizard();
    api.checkConfigBeacon = (params: CheckConfigBeaconParams): Promise<CheckConfigBeaconResult> => Promise.resolve({
      status: 'found',
      location: `s3://${params.bucket}/costgoblin/org-config.yaml`,
      content: 'kind: costgoblin-config-bundle',
      summary: {
        schemaVersion: 1,
        appVersion: '0.2.0',
        exportedAt: '2026-06-01T09:00:00.000Z',
        fingerprint: 'feedfacefeedfacefeedfacefeedface',
        fingerprintValid: true,
        sections: ['config', 'dimensions'],
        providers: [{ name: 'aws-main', dailyBucket: 's3://my-cur-bucket/daily/' }],
        builtInDimensionCount: 7,
        tagDimensionCount: 3,
        orgTreeNodeCount: 0,
        exclusionRuleCount: 0,
        viewCount: 0,
        baselineCount: 0,
      },
    });
    const applySpy = vi.spyOn(api, 'applyConfigBundle');

    await user.click(screen.getByText('Get Started'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));

    await waitFor(() => { expect(screen.getByText('Team configuration found')).toBeDefined(); });
    expect(screen.getByText('s3://my-cur-bucket/daily/')).toBeDefined();

    await user.click(screen.getByText('Use this configuration'));
    await waitFor(() => { expect(onComplete).toHaveBeenCalledOnce(); });
    expect(applySpy).toHaveBeenCalledWith({ content: 'kind: costgoblin-config-bundle', profile: 'default' });
  });

  it('lets the user decline the discovered configuration and set up manually', async () => {
    const { api, user } = renderWizard();
    api.checkConfigBeacon = () => Promise.resolve({
      status: 'found',
      location: 's3://my-cur-bucket/costgoblin/org-config.yaml',
      content: 'kind: costgoblin-config-bundle',
      summary: {
        schemaVersion: 1,
        appVersion: '0.2.0',
        exportedAt: '2026-06-01T09:00:00.000Z',
        fingerprint: 'feedfacefeedfacefeedfacefeedface',
        fingerprintValid: true,
        sections: ['config', 'dimensions'],
        providers: [{ name: 'aws-main', dailyBucket: 's3://my-cur-bucket/daily/' }],
        builtInDimensionCount: 7,
        tagDimensionCount: 3,
        orgTreeNodeCount: 0,
        exclusionRuleCount: 0,
        viewCount: 0,
        baselineCount: 0,
      },
    });

    await user.click(screen.getByText('Get Started'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByText('default'));
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    await user.click(screen.getByText('my-cur-bucket'));
    await waitFor(() => { expect(screen.getByText('Team configuration found')).toBeDefined(); });

    await user.click(screen.getByText('Set up manually instead'));
    await waitFor(() => { expect(screen.getAllByText('data/').length).toBeGreaterThan(0); });
  });

  it('opens the import dialog from the welcome step', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByText('Import from a teammate'));
    await waitFor(() => { expect(screen.getByText('Choose bundle file…')).toBeDefined(); });
  });

  it('returns to the welcome screen from a wizard step via the close button', async () => {
    const { user } = renderWizard();
    await user.click(screen.getByText('Get Started'));
    await waitFor(() => { expect(screen.getByText('default')).toBeDefined(); });
    await user.click(screen.getByLabelText('Back to welcome'));
    await waitFor(() => { expect(screen.getByText('Import from a teammate')).toBeDefined(); });
  });

  it('does not show the close button on the welcome step', () => {
    renderWizard();
    expect(screen.queryByLabelText('Back to welcome')).toBeNull();
  });
});

// The desktop window has no native title bar (titleBarStyle: hiddenInset), and
// standalone onboarding renders without the app header that normally hosts the
// macOS drag region — so the wizard backdrop must itself be draggable or the
// window can't be moved at all during setup (issue #317).
describe('SetupWizard window drag region', () => {
  it('standalone wizard backdrop is a drag region and the card opts out', () => {
    const { container } = renderWizard();
    expect(container.firstElementChild?.className).toContain('[-webkit-app-region:drag]');
    expect(container.querySelector('[class*="[-webkit-app-region:no-drag]"]')).not.toBeNull();
  });

  it('embedded source mode (Data Management modal) is not a drag region', async () => {
    const { container } = renderWizard({ source: 'daily', profile: 'default' });
    await waitFor(() => { expect(screen.getByText('my-cur-bucket')).toBeDefined(); });
    expect(container.firstElementChild?.className).not.toContain('[-webkit-app-region:drag]');
  });
});

describe('SetupWizard workspace naming', () => {
  it('seeds the name field from workspaceNaming present at mount', () => {
    const api = new MockCostApi();
    render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={vi.fn()} workspaceNaming={{ initialName: 'default' }} />
      </CostApiProvider>,
    );
    expect(screen.getByLabelText('Workspace name')).toHaveProperty('value', 'default');
  });

  // The host learns the workspace mode from an IPC round-trip that races the
  // setup check, so the prop routinely arrives only after the wizard mounted —
  // the field must pick up the initial name instead of staying empty+invalid.
  it('seeds the name field when workspaceNaming arrives after mount', async () => {
    const api = new MockCostApi();
    const onComplete = vi.fn();
    const { rerender } = render(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} />
      </CostApiProvider>,
    );
    expect(screen.queryByLabelText('Workspace name')).toBeNull();
    rerender(
      <CostApiProvider value={api}>
        <SetupWizard onComplete={onComplete} workspaceNaming={{ initialName: 'default' }} />
      </CostApiProvider>,
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Workspace name')).toHaveProperty('value', 'default');
    });
    expect(screen.getByRole('button', { name: 'Get Started' }).hasAttribute('disabled')).toBe(false);
  });
});
