import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostOverview } from '../views/cost-overview.js';

function renderOverview() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <CostOverview />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

afterEach(cleanup);

describe('CostOverview', () => {
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
});
