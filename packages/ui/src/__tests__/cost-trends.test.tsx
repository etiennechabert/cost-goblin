import { render, screen, waitFor, within, cleanup } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { TrendResult } from '@costgoblin/core/browser';
import { asDollars, asEntityRef } from '@costgoblin/core/browser';
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

/** Two entities with no cost in the previous period: new spend, and a new credit. */
class NewEntitiesApi extends MockCostApi {
  override queryTrends(): Promise<TrendResult> {
    return Promise.resolve({
      increases: [{ entity: asEntityRef('new-spend'), currentCost: asDollars(500), previousCost: asDollars(0), delta: asDollars(500), percentChange: 100 }],
      savings: [{ entity: asEntityRef('new-credit'), currentCost: asDollars(-75), previousCost: asDollars(0), delta: asDollars(-75), percentChange: -100 }],
      totalIncrease: asDollars(500),
      totalSavings: asDollars(75),
    });
  }
}

/** The table row naming an entity. A text query, not a role query: role
 *  queries walk the chart-heavy DOM computing accessible names on every poll,
 *  which can outlast the find timeout on a loaded CI runner. */
async function entityRow(entity: string): Promise<HTMLElement> {
  const row = (await screen.findByText(entity)).closest('tr');
  if (row === null) throw new Error(`no table row for ${entity}`);
  return row;
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

  it('shows ±100% for an entity with no previous cost, signed like its change', async () => {
    render(
      <CostApiProvider value={new NewEntitiesApi()}>
        <CostTrends />
      </CostApiProvider>,
    );
    expect(within(await entityRow('new-spend')).getByText('+100.0%')).toBeDefined();
    expect(within(await entityRow('new-credit')).getByText('-100.0%')).toBeDefined();
  });
});
