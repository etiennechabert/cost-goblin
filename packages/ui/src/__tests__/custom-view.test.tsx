import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { ViewSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CustomView } from '../views/custom-view.js';

const SPEC: ViewSpec = {
  id: 'test',
  name: 'Test View',
  rows: [
    {
      widgets: [
        { id: 's1', type: 'summary', size: 'small', metric: 'total' },
        { id: 'p1', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
      ],
    },
    {
      widgets: [
        { id: 't1', type: 'topNBar', size: 'large', groupBy: asDimensionId('account'), topN: 5 },
      ],
    },
  ],
};

afterEach(cleanup);

function renderView(spec: ViewSpec = SPEC) {
  return render(
    <CostApiProvider value={new MockCostApi()}>
      <CustomView spec={spec} headerSubtitle="hello" />
    </CostApiProvider>,
  );
}

describe('CustomView', () => {
  it('renders the view name as a heading', () => {
    renderView();
    expect(screen.getByText('Test View')).toBeDefined();
  });

  it('renders the header subtitle when provided', () => {
    renderView();
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('renders the summary card after data loads', async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeDefined();
    });
  });

  it('does not crash with an empty spec', () => {
    const empty: ViewSpec = { id: 'e', name: 'Empty', rows: [] };
    expect(() => renderView(empty)).not.toThrow();
    expect(screen.getByText('Empty')).toBeDefined();
  });
});
