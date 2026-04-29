import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostTrends } from '../views/cost-trends.js';

function renderTrends(api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  const onEntityClick = vi.fn();
  return {
    api: mockApi,
    onEntityClick,
    ...render(
      <CostApiProvider value={mockApi}>
        <CostTrends onEntityClick={onEntityClick} />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('CostTrends', () => {
  it('shows loading state initially', () => {
    renderTrends();
    expect(screen.getByText('Loading trends...')).toBeDefined();
  });

  it('shows trend data and columns after loading', async () => {
    renderTrends();
    await waitFor(() => {
      expect(screen.getByText(/platform/)).toBeDefined();
      expect(screen.getByText('Entity')).toBeDefined();
      expect(screen.getByText('Current')).toBeDefined();
      expect(screen.getByText('Previous')).toBeDefined();
    });
  });

  it('renders header with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderTrends(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading trends...')).toBeNull();
    });
    expect(screen.getByText('Cost Trends')).toBeDefined();
    expect(screen.getByText('Period-over-period comparison')).toBeDefined();
  });

  it('shows loading indicator on initial render', async () => {
    renderTrends();
    expect(screen.getByText('Loading trends...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Loading trends...')).toBeNull();
    });
  });

  it('does not render table headers with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderTrends(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading trends...')).toBeNull();
    });
    expect(screen.queryByText('Entity')).toBeNull();
    expect(screen.queryByText('Current')).toBeNull();
    expect(screen.queryByText('Previous')).toBeNull();
  });

  it('renders header with zero-cost entities', async () => {
    const api = MockCostApi.withZeroCostEntities();
    renderTrends(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading trends...')).toBeNull();
    });
    expect(screen.getByText('Cost Trends')).toBeDefined();
    expect(screen.getByText('Period-over-period comparison')).toBeDefined();
  });

  it('does not render table headers with zero-cost entities', async () => {
    const api = MockCostApi.withZeroCostEntities();
    renderTrends(api);
    await waitFor(() => {
      expect(screen.queryByText('Loading trends...')).toBeNull();
    });
    expect(screen.queryByText('Entity')).toBeNull();
    expect(screen.queryByText('Current')).toBeNull();
    expect(screen.queryByText('Previous')).toBeNull();
  });

  it('shows loading indicator before displaying zero-cost entities', async () => {
    const api = MockCostApi.withZeroCostEntities();
    renderTrends(api);
    expect(screen.getByText('Loading trends...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Loading trends...')).toBeNull();
    });
  });
});
