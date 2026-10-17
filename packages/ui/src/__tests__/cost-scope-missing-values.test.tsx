import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect } from 'vitest';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostScopeView } from '../views/cost-scope.js';

function renderView() {
  const api = new MockCostApi();
  const user = userEvent.setup();
  return {
    api,
    user,
    ...render(
      <CostApiProvider value={api}>
        <CostScopeView />
      </CostApiProvider>,
    ),
  };
}

afterEach(cleanup);

/** Adds a rule and enables it. Its condition starts with no values. The new
 *  rule renders last, so its switch and checkbox are the last of their kind. */
async function addEnabledRule(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Add rule' }));
  await user.click(screen.getAllByRole('switch').at(-1) ?? document.body);
}

function newRuleMissingCheckbox(): HTMLElement {
  return screen.getAllByRole('checkbox', { name: 'Missing values' }).at(-1) ?? document.body;
}

describe('CostScopeView — Missing values on a condition', () => {
  it('offers the tickbox on every condition, unticked', async () => {
    renderView();
    // One per built-in rule's condition.
    await waitFor(() => { expect(screen.getAllByRole('checkbox', { name: 'Missing values' }).length).toBeGreaterThan(0); });
    for (const box of screen.getAllByRole('checkbox', { name: 'Missing values' })) {
      expect(box).toHaveProperty('checked', false);
    }
  });

  it('lets an enabled rule exclude only missing values, with no values typed', async () => {
    const { api, user } = renderView();
    await addEnabledRule(user);
    // Enabled with nothing to match: not saveable.
    expect(screen.getByText(/has a condition with no values/)).toBeDefined();

    await user.click(newRuleMissingCheckbox());

    expect(screen.queryByText(/has a condition with no values/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => { expect(api.savedCostScopes).toHaveLength(1); });
    const saved = api.savedCostScopes.at(-1)?.rules.at(-1);
    expect(saved?.enabled).toBe(true);
    expect(saved?.conditions).toEqual([expect.objectContaining({ values: [], matchMissing: true })]);
  });

  it('previews the rule once it matches missing values', async () => {
    const { api, user } = renderView();
    await addEnabledRule(user);
    const before = api.costScopePreviewRanges.length;
    await user.click(newRuleMissingCheckbox());
    // The draft is valid again, so the debounced preview runs.
    await waitFor(() => { expect(api.costScopePreviewRanges.length).toBeGreaterThan(before); });
  });

  it('unticking drops the flag, leaving the draft as it was', async () => {
    const { api, user } = renderView();
    await addEnabledRule(user);
    await user.type(screen.getAllByPlaceholderText('Values (comma-separated)').at(-1) ?? document.body, 'EC2');
    await user.click(newRuleMissingCheckbox());
    await user.click(newRuleMissingCheckbox());

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => { expect(api.savedCostScopes).toHaveLength(1); });
    const condition = api.savedCostScopes.at(-1)?.rules.at(-1)?.conditions[0];
    expect(condition?.values).toEqual(['EC2']);
    // No `matchMissing: false` left behind — the dirty/Reset checks compare JSON.
    expect(JSON.parse(JSON.stringify(condition))).not.toHaveProperty('matchMissing');
  });
});
