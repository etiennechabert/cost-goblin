import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostOverview } from '../views/cost-overview.js';

function renderOverview() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <CostOverview />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('CostOverview', () => {
  it('renders heading', () => {
    renderOverview();
    expect(screen.getByText('Cost Overview')).toBeDefined();
  });

  it('shows loading state initially', () => {
    renderOverview();
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('renders summary and chart sections after data loads', async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });
    expect(screen.getByText('Daily Costs')).toBeDefined();
  });

  it('renders daily costs chart with tab selector', async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getByText('Daily Costs')).toBeDefined();
    });
    expect(screen.getByText('Groups')).toBeDefined();
    expect(screen.getByText('Products')).toBeDefined();
    expect(screen.getByText('Services')).toBeDefined();
  });

  it('date range picker is visible with "30 days" selected by default', () => {
    renderOverview();
    const btn30d = screen.getByText('30 days');
    expect(btn30d).toBeDefined();
    expect(btn30d.className).toContain('bg-bg-secondary');
  });

  it('changing date range triggers a new query', async () => {
    const { api, user } = renderOverview();
    const queryCostsSpy = vi.spyOn(api, 'queryCosts');

    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });

    const initialCallCount = queryCostsSpy.mock.calls.length;
    await user.click(screen.getByText('7 days'));

    await waitFor(() => {
      expect(queryCostsSpy.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('renders summary card with total cost', async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });
  });
});
