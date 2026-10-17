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

describe('CostScopeView — marketplace attribution toggle', () => {
  it('renders the section On by default and lists the Bedrock rule', async () => {
    renderView();
    await waitFor(() => { expect(screen.getByText('Marketplace attribution')).toBeDefined(); });
    expect(screen.getByText('Amazon Bedrock')).toBeDefined();
    expect(screen.getByText(/^On$/)).toBeDefined();
  });

  it('saves with enabled=false when toggled off', async () => {
    const { api, user } = renderView();

    await waitFor(() => { expect(screen.getByText('Marketplace attribution')).toBeDefined(); });

    // The marketplace checkbox is the one whose label text is "On"/"Off".
    const onLabel = screen.getByText(/^On$/);
    const checkbox = onLabel.parentElement?.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await user.click(checkbox as Element);

    const saveBtn = await screen.findByRole('button', { name: /save/i });
    await user.click(saveBtn);

    await waitFor(() => { expect(api.savedCostScopes.length).toBeGreaterThan(0); });
    const saved = api.savedCostScopes.at(-1);
    expect(saved?.marketplaceAttribution?.enabled).toBe(false);
    // Rules are preserved so re-enabling restores them.
    expect(saved?.marketplaceAttribution?.rules.length).toBeGreaterThan(0);
  });
});
