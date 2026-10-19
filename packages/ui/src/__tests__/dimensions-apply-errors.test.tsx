import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { CostApi, DimensionsConfig } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** Applying the Dimensions draft: the in-flight state, and what a failed save
 *  tells the user (the draft is kept, so they can retry or discard it). */

const CONFIG: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
    { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' },
  ],
  tags: [],
};

function renderView() {
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(CONFIG);
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { save, user };
}

/** Toggling the Charge Category pill makes the draft dirty. */
async function editDraft(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Charge Category' }));
  await screen.findByRole('button', { name: /Apply & rebuild/ });
}

function applyButton(): HTMLElement {
  return screen.getByRole('button', { name: /Apply & rebuild|Applying…/ });
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('DimensionsView — applying the draft', () => {
  it('shows the save in flight and settles back to Saved', async () => {
    const { save, user } = renderView();
    let finish: () => void = () => undefined;
    save.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    await editDraft(user);
    expect(screen.getByText('Previewing changes — the rollup rebuilds only when you apply.')).toBeDefined();

    await user.click(applyButton());
    expect(applyButton().textContent).toBe('Applying…');
    expect(applyButton()).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);

    await act(async () => { finish(); await Promise.resolve(); });
    await waitFor(() => { expect(screen.getByText('Saved')).toBeDefined(); });
    expect(screen.queryByText('Previewing changes — the rollup rebuilds only when you apply.')).toBeNull();
  });

  it('reports a failed save, keeps the draft, and can be dismissed', async () => {
    const { save, user } = renderView();
    save.mockRejectedValue(new Error('disk full'));
    await editDraft(user);

    await user.click(applyButton());
    expect(await screen.findByText('Couldn’t apply your changes: disk full')).toBeDefined();
    // Still a draft: Apply is offered again.
    expect(applyButton().textContent).toBe('Apply & rebuild rollup');
    expect(applyButton()).toHaveProperty('disabled', false);

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/Couldn’t apply your changes/)).toBeNull();
    expect(applyButton()).toBeDefined();
  });

  it('falls back to a generic message for a failure that is not an Error', async () => {
    const { save, user } = renderView();
    save.mockRejectedValue('EACCES');
    await editDraft(user);
    await user.click(applyButton());
    expect(await screen.findByText('Couldn’t apply your changes: Failed to save dimensions')).toBeDefined();
  });

  it('discarding the draft also clears a failed save\'s message', async () => {
    const { save, user } = renderView();
    save.mockRejectedValue(new Error('disk full'));
    await editDraft(user);
    await user.click(applyButton());
    await screen.findByText('Couldn’t apply your changes: disk full');

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByText(/Couldn’t apply your changes/)).toBeNull();
    expect(screen.getByText('Saved')).toBeDefined();
  });
});
