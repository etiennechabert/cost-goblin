import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import type { CostScopeConfig } from '@costgoblin/core/browser';
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
    expect(screen.getByText('AmazonBedrock')).toBeDefined();
    expect(screen.getByText(/^On$/)).toBeDefined();
  });

  it('saves with enabled=false when toggled off', async () => {
    const { api, user } = renderView();
    const saveSpy = vi.spyOn(api, 'saveCostScope');

    await waitFor(() => { expect(screen.getByText('Marketplace attribution')).toBeDefined(); });

    // The marketplace checkbox is the one whose label text is "On"/"Off".
    const onLabel = screen.getByText(/^On$/);
    const checkbox = onLabel.parentElement?.querySelector('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    await user.click(checkbox as Element);

    const saveBtn = await screen.findByRole('button', { name: /save/i });
    await user.click(saveBtn);

    await waitFor(() => { expect(saveSpy).toHaveBeenCalled(); });
    // The mock's saveCostScope signature drops its arg, so the spy types calls
    // as []; the runtime arg is still passed — recover it through a cast.
    const calls = saveSpy.mock.calls as unknown as CostScopeConfig[][];
    const saved = calls.at(-1)?.[0];
    expect(saved?.marketplaceAttribution?.enabled).toBe(false);
    // Rules are preserved so re-enabling restores them.
    expect(saved?.marketplaceAttribution?.rules.length).toBeGreaterThan(0);
  });
});
