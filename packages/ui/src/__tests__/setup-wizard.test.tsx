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
  it('renders welcome step', () => {
    renderWizard();
    expect(screen.getByText('CostGoblin')).toBeDefined();
    expect(screen.getByText('Cloud cost visibility for your team')).toBeDefined();
    expect(screen.getByText('Get Started')).toBeDefined();
  });

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

  it('onComplete callback is provided but not called on render', () => {
    const { onComplete } = renderWizard();
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText('CostGoblin')).toBeDefined();
  });
});
