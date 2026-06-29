import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

function renderView() {
  const api = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [
      { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
      { name: asDimensionId('service'), label: 'AWS Service', field: 'service' },
      { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' },
    ],
    tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }],
  });
  const saveSpy = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  return {
    api,
    saveSpy,
    user,
    ...render(
      <CostApiProvider value={api}>
        <DimensionsView />
      </CostApiProvider>,
    ),
  };
}

/** The dimension pills only render once the config has loaded; "Saved" alone
 *  isn't enough (it also shows while config is still null/loading). */
function resourcePill(): HTMLElement {
  const pill = screen.getAllByRole('button', { name: /Resource/ })[0];
  if (pill === undefined) throw new Error('Resource pill not rendered yet');
  return pill;
}

afterEach(cleanup);

describe('DimensionsView — draft / apply model', () => {
  it('does not persist (no re-roll) while toggling; Apply commits the draft', async () => {
    const { saveSpy, user } = renderView();
    // Loaded clean: pills present, "Saved" shown, no Apply button, nothing persisted.
    await waitFor(() => { resourcePill(); });
    expect(screen.getByText('Saved')).toBeDefined();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Apply & rebuild/i })).toBeNull();

    // Toggle a dimension → draft is dirty, but still NOT persisted.
    await user.click(resourcePill());
    await waitFor(() => { expect(screen.getByRole('button', { name: /Apply & rebuild/i })).toBeDefined(); });
    expect(saveSpy).not.toHaveBeenCalled();

    // Apply → persists exactly once (the single re-roll trigger).
    await user.click(screen.getByRole('button', { name: /Apply & rebuild/i }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(1); });

    // Back to a clean "Saved" state after a successful apply.
    await waitFor(() => { expect(screen.getByText('Saved')).toBeDefined(); });
  });

  it('Discard reverts the draft without persisting', async () => {
    const { saveSpy, user } = renderView();
    await waitFor(() => { resourcePill(); });

    await user.click(resourcePill());
    await waitFor(() => { expect(screen.getByRole('button', { name: /Discard/i })).toBeDefined(); });

    await user.click(screen.getByRole('button', { name: /Discard/i }));
    // Reverted: no Apply button, nothing ever persisted.
    await waitFor(() => { expect(screen.queryByRole('button', { name: /Apply & rebuild/i })).toBeNull(); });
    expect(saveSpy).not.toHaveBeenCalled();
  });
});
