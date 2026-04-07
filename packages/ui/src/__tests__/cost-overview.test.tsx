import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostOverview } from '../views/cost-overview.js';

function renderOverview(onEntityClick?: (entity: string, dimension: string) => void) {
  const api = new MockCostApi();
  const user = userEvent.setup();
  const props = onEntityClick !== undefined ? { onEntityClick } : {};
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <CostOverview {...props} />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('CostOverview', () => {
  it('renders "Cost Overview" heading', () => {
    renderOverview();
    expect(screen.getByText('Cost Overview')).toBeDefined();
  });

  it('shows loading state initially', () => {
    renderOverview();
    expect(screen.getByText('Loading\u2026')).toBeDefined();
  });

  it('shows dimension selector after data loads', async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getAllByText('Account').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Service').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Region').length).toBeGreaterThan(0);
  });

  it('shows cost table with entity data after loading', async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });
    expect(screen.getByText('data')).toBeDefined();
    expect(screen.getByText('growth')).toBeDefined();
    expect(screen.getByText('infra')).toBeDefined();
    expect(screen.getByText('ml')).toBeDefined();
  });

  it('date range picker is visible with "30 days" selected by default', () => {
    renderOverview();
    const btn30d = screen.getByText('30 days');
    expect(btn30d).toBeDefined();
    expect(btn30d.className).toContain('bg-bg-secondary');
  });

  it('changing date range triggers a new query with updated range', async () => {
    const { api, user } = renderOverview();
    const queryCostsSpy = vi.spyOn(api, 'queryCosts');

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    const initialCallCount = queryCostsSpy.mock.calls.length;

    await user.click(screen.getByText('7 days'));

    await waitFor(() => {
      expect(queryCostsSpy.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it('filter bar shows dimension chips', async () => {
    renderOverview();
    await waitFor(() => {
      expect(screen.getAllByText('Account').length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText('Team').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Environment').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Product').length).toBeGreaterThan(0);
  });

  it('clicking an entity name in the table opens the popup', async () => {
    const { user } = renderOverview();

    await waitFor(() => {
      expect(screen.getByText('platform')).toBeDefined();
    });

    const entityButton = screen.getByRole('button', { name: 'platform' });
    await user.click(entityButton);

    await waitFor(() => {
      expect(screen.getByText('Set as filter')).toBeDefined();
      expect(screen.getByText('Open full view')).toBeDefined();
    });
  });
});
