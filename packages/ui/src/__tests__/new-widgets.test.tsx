import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { ViewSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CustomView } from '../views/custom-view.js';

const VIEW: ViewSpec = {
  id: 'new-widgets',
  name: 'New Widgets',
  rows: [
    {
      widgets: [
        { id: 'wf', type: 'waterfall', size: 'large', groupBy: asDimensionId('service') },
        { id: 'pv', type: 'priceVolume', size: 'large', groupBy: asDimensionId('service') },
      ],
    },
    {
      widgets: [
        { id: 'bd', type: 'burndown', size: 'large', budget: 100_000 },
        { id: 'pa', type: 'pareto', size: 'large', groupBy: asDimensionId('service') },
      ],
    },
  ],
};

afterEach(cleanup);

function renderView(spec: ViewSpec = VIEW) {
  return render(
    <CostApiProvider value={new MockCostApi()}>
      <CustomView spec={spec} headerSubtitle="hello" />
    </CostApiProvider>,
  );
}

describe('new analysis widgets', () => {
  it('renders all four widget types without crashing', () => {
    expect(() => renderView()).not.toThrow();
    expect(screen.getByText('New Widgets')).toBeDefined();
  });

  it('renders the burndown widget once data loads', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/Cumulative spend/)).toBeDefined();
    });
  });

  it('shows the price-volume empty state when there is no period-over-period change', async () => {
    // MockCostApi returns identical current/previous aggregates, so every
    // group's delta is zero and the decomposition is empty.
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/No period-over-period change to decompose/)).toBeDefined();
    });
  });
});
