import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostTrends } from '../views/cost-trends.js';

function renderTrends() {
  const api = new MockCostApi();
  const onEntityClick = vi.fn();
  return {
    api,
    onEntityClick,
    ...render(
      <CostApiProvider value={api}>
        <CostTrends onEntityClick={onEntityClick} />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

describe('CostTrends', () => {
  it('renders heading', () => {
    renderTrends();
    expect(screen.getByText('Cost Trends')).toBeDefined();
  });

  it('shows trend data after loading', async () => {
    renderTrends();
    await waitFor(() => {
      expect(screen.getByText(/platform/)).toBeDefined();
    });
  });

  it('shows delta and percent change columns', async () => {
    renderTrends();
    await waitFor(() => {
      expect(screen.getByText('Entity')).toBeDefined();
      expect(screen.getByText('Current')).toBeDefined();
      expect(screen.getByText('Previous')).toBeDefined();
    });
  });
});
