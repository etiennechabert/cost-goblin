import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { ViewSpec } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
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

function renderView(spec: ViewSpec = SPEC, api?: MockCostApi) {
  const mockApi = api ?? new MockCostApi();
  return render(
    <PaletteProvider>
      <CostApiProvider value={mockApi}>
        <CustomView spec={spec} headerSubtitle="hello" />
      </CostApiProvider>
    </PaletteProvider>,
  );
}

describe('CustomView', () => {
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

  it('shows loading state initially', () => {
    renderView();
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('shows loading indicator on initial render', async () => {
    renderView();
    expect(screen.getByText('Loading...')).toBeDefined();
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
  });

  it('renders widgets with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderView(SPEC, api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('Test View')).toBeDefined();
  });

  it('renders view header with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderView(SPEC, api);
    await waitFor(() => {
      expect(screen.queryByText('Loading...')).toBeNull();
    });
    expect(screen.getByText('Test View')).toBeDefined();
    expect(screen.getByText('hello')).toBeDefined();
  });

  it('displays widgets even with empty data', async () => {
    const api = MockCostApi.withEmptyData();
    renderView(SPEC, api);
    await waitFor(() => {
      expect(screen.getByText('Test View')).toBeDefined();
    });
    expect(screen.getByText('Total Cost')).toBeDefined();
  });
});
