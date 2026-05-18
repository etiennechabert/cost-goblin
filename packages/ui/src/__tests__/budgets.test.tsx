import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { BudgetsView } from '../views/budgets.js';

function renderBudgets() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          <BudgetsView />
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

afterEach(cleanup);

describe('BudgetsView', () => {
  it('renders header and Add Budget control', async () => {
    renderBudgets();
    await waitFor(() => {
      expect(screen.getByText('Budgets')).toBeDefined();
    });
    expect(screen.getByRole('button', { name: 'Add Budget' })).toBeDefined();
  });

  it('renders summary cards when budgets exist for the active dim', async () => {
    renderBudgets();
    // Default active dim = Account, which has 3 seeded budgets.
    await waitFor(() => {
      expect(screen.getByText('Total annual budget')).toBeDefined();
    });
    expect(screen.getByText('Total spent')).toBeDefined();
    expect(screen.getByText('Overall usage')).toBeDefined();
    expect(screen.getByText('Over budget')).toBeDefined();
  });

  it('switching dimension re-fires queryCosts', async () => {
    const { api, user } = renderBudgets();
    const spy = vi.spyOn(api, 'queryCosts');

    const serviceTab = await screen.findByRole('button', { name: 'Service' });
    const initialCalls = spy.mock.calls.length;
    await user.click(serviceTab);

    await waitFor(() => {
      expect(spy.mock.calls.length).toBeGreaterThan(initialCalls);
    });
  });

  it('opens create modal when "Add Budget" is clicked', async () => {
    const { user } = renderBudgets();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Add Budget' })).toBeDefined();
    });
    await user.click(screen.getByRole('button', { name: 'Add Budget' }));
    await waitFor(() => {
      expect(screen.getByText('Add Budget', { selector: 'h2' })).toBeDefined();
    });
  });

  it('shows empty state when the active dimension has no budgets', async () => {
    const { user } = renderBudgets();
    const regionTab = await screen.findByRole('button', { name: 'Region' });
    await user.click(regionTab);
    await waitFor(() => {
      expect(screen.getByText('No budgets set for this dimension')).toBeDefined();
    });
  });

  it('clicking a budget card opens the edit modal', async () => {
    const { user } = renderBudgets();
    // Account is the default dim and has seeded budgets.
    const platformCard = await screen.findByText('platform');
    await user.click(platformCard);

    await waitFor(() => {
      expect(screen.getByText('Edit Budget')).toBeDefined();
    });
  });
});
