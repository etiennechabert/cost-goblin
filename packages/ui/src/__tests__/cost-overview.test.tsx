import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostOverview } from '../views/cost-overview.js';

function renderOverview(api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  const user = userEvent.setup();
  return {
    api: mockApi,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={mockApi}>
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

  it('shows no filter bar when dimensions are empty', async () => {
    const api = MockCostApi.withEmptyData();
    renderOverview(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.queryByText('Filters')).toBeNull();
  });

  it('renders widgets with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderOverview(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('Cost Overview')).toBeDefined();
  });

  it('renders view header with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderOverview(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('Cost Overview')).toBeDefined();
    expect(screen.getByText('Cloud spending visibility')).toBeDefined();
  });

  it('displays date range picker even with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderOverview(api);
    await waitFor(() => {
      expect(screen.getByText('Cost Overview')).toBeDefined();
    });
    const buttons = screen.getAllByText('30 days');
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('shows loading indicator on initial render', async () => {
    renderOverview();
    expect(screen.getByText('Loading...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
  });
});
