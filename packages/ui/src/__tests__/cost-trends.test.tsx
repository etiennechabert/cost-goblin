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
  it('shows trend data and columns after loading', async () => {
    renderTrends();
    await waitFor(() => {
      expect(screen.getByText(/platform/)).toBeDefined();
      expect(screen.getByText('Entity')).toBeDefined();
      expect(screen.getByText('Current')).toBeDefined();
      expect(screen.getByText('Previous')).toBeDefined();
    });
  });
});
