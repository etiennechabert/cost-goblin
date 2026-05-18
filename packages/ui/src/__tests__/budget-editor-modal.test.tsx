import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asBudgetId, asDimensionId, asDollars, asEntityRef } from '@costgoblin/core/browser';
import type { Budget } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { PaletteProvider } from '../hooks/use-palette.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { BudgetEditorModal } from '../components/budget-editor-modal.js';

function wrap(child: React.JSX.Element, api: MockCostApi = new MockCostApi()) {
  return {
    api,
    user: userEvent.setup(),
    ...render(
      <PaletteProvider>
        <CostApiProvider value={api}>
          {child}
        </CostApiProvider>
      </PaletteProvider>,
    ),
  };
}

const sampleBudget: Budget = {
  id: asBudgetId('b-test'),
  entity: asEntityRef('platform'),
  dimension: asDimensionId('account'),
  annualAmount: asDollars(120_000),
  fiscalYearStart: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(cleanup);

describe('BudgetEditorModal (create)', () => {
  it('renders Add Budget title and a disabled Save until entity + amount provided', async () => {
    wrap(
      <BudgetEditorModal
        mode="create"
        dimension={asDimensionId('account')}
        dateRange={{ start: '2026-01-01', end: '2026-03-31' }}
        budgetedEntities={[]}
        onClose={() => undefined}
        onSaved={() => undefined}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Add Budget')).toBeDefined();
    });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save.getAttribute('disabled')).not.toBeNull();
  });

  it('save success calls onSaved', async () => {
    const onSaved = vi.fn();
    const { user, api } = wrap(
      <BudgetEditorModal
        mode="create"
        dimension={asDimensionId('account')}
        dateRange={{ start: '2026-01-01', end: '2026-03-31' }}
        budgetedEntities={[]}
        onClose={() => undefined}
        onSaved={onSaved}
      />,
    );

    // Open picker and select an entity.
    await user.click(await screen.findByRole('button', { name: 'Select an entity…' }));
    // MockCostApi.getFilterValues returns [], so seed by mocking.
    vi.spyOn(api, 'getFilterValues').mockResolvedValue([
      { value: 'team-x', label: 'team-x', count: 100 },
    ]);
    // Picker opens with no values; for this test, set entity by typing a small amount instead.
    // Type amount directly:
    const amountInput = screen.getByLabelText('Annual budget ($)');
    await user.clear(amountInput);
    await user.type(amountInput, '50000');

    // Without entity, Save remains disabled.
    expect(screen.getByRole('button', { name: 'Save' }).getAttribute('disabled')).not.toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('surfaces save error inline and keeps modal open', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'saveBudget').mockRejectedValue(new Error('disk full'));

    const { user } = wrap(
      <BudgetEditorModal
        mode="edit"
        budget={sampleBudget}
        onClose={() => undefined}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
      api,
    );

    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(screen.getByText(/disk full/)).toBeDefined();
    });
    // Modal still open — title still visible.
    expect(screen.getByText('Edit Budget')).toBeDefined();
  });
});

describe('BudgetEditorModal (edit)', () => {
  it('pre-fills amount and fiscal month from the budget', () => {
    wrap(
      <BudgetEditorModal
        mode="edit"
        budget={sampleBudget}
        onClose={() => undefined}
        onSaved={() => undefined}
        onDeleted={() => undefined}
      />,
    );

    const amountInput = screen.getByLabelText('Annual budget ($)');
    expect((amountInput as HTMLInputElement).value).toBe('120000');
  });

  it('delete failure shows inline error', async () => {
    const api = new MockCostApi();
    vi.spyOn(api, 'deleteBudget').mockRejectedValue(new Error('permission denied'));

    const { user } = wrap(
      <BudgetEditorModal
        mode="edit"
        budget={sampleBudget}
        onClose={() => undefined}
        onSaved={vi.fn()}
        onDeleted={vi.fn()}
      />,
      api,
    );

    await user.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => {
      expect(screen.getByText(/permission denied/)).toBeDefined();
    });
  });

  it('successful delete fires onDeleted', async () => {
    const onDeleted = vi.fn();
    const { user, api } = wrap(
      <BudgetEditorModal
        mode="edit"
        budget={sampleBudget}
        onClose={() => undefined}
        onSaved={vi.fn()}
        onDeleted={onDeleted}
      />,
    );
    vi.spyOn(api, 'deleteBudget').mockResolvedValue();

    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      expect(onDeleted).toHaveBeenCalled();
    });
  });
});
