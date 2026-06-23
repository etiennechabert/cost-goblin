import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { SchedulerControls } from '../components/scheduler-controls.js';

function renderControls(api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  const user = userEvent.setup();
  return {
    api: mockApi,
    user,
    ...render(
      <CostApiProvider value={mockApi}>
        <SchedulerControls />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('SchedulerControls', () => {
  it('renders auto-sync, auto-prune and the interval selector', async () => {
    renderControls();
    await waitFor(() => {
      expect(screen.getByText('Auto-sync')).toBeDefined();
      expect(screen.getByText('Auto-prune')).toBeDefined();
    });
    // Interval options are the four clean cadences.
    for (const label of ['Hourly', 'Daily', 'Weekly', 'Monthly']) {
      expect(screen.getByRole('option', { name: label })).toBeDefined();
    }
  });

  it('toggling auto-sync persists the new state', async () => {
    const api = new MockCostApi();
    const spy = vi.spyOn(api, 'setAutoSyncEnabled');
    const { user } = renderControls(api);
    await user.click(await screen.findByRole('button', { name: 'Toggle auto-sync' }));
    await waitFor(() => { expect(spy).toHaveBeenCalledWith(true); });
  });

  it('toggling auto-prune persists the new state', async () => {
    const api = new MockCostApi();
    const spy = vi.spyOn(api, 'setAutoPruneEnabled');
    const { user } = renderControls(api);
    await user.click(await screen.findByRole('button', { name: 'Toggle auto-prune' }));
    await waitFor(() => { expect(spy).toHaveBeenCalledWith(true); });
  });

  it('the interval selector is disabled until a schedule is enabled', async () => {
    const api = new MockCostApi();
    api.getAutoSyncEnabled = () => Promise.resolve(false);
    api.getAutoPruneEnabled = () => Promise.resolve(false);
    renderControls(api);
    const select = await screen.findByRole('combobox');
    await waitFor(() => { expect(select).toHaveProperty('disabled', true); });
  });

  it('changing the interval persists the chosen cadence', async () => {
    const api = new MockCostApi();
    api.getAutoSyncEnabled = () => Promise.resolve(true);
    const spy = vi.spyOn(api, 'setAutoSyncIntervalMinutes');
    const { user } = renderControls(api);
    const select = await screen.findByRole('combobox');
    await waitFor(() => { expect(select).toHaveProperty('disabled', false); });
    await user.selectOptions(select, 'Monthly');
    await waitFor(() => { expect(spy).toHaveBeenCalledWith(43200); });
  });
});
