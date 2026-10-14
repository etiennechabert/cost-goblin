import { render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { TagDimension } from '@costgoblin/core/browser';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** Tag keys that differ only by punctuation (`cost-center`, `cost_center`)
 *  share a dimension id (`tag_cost_center`). Every id lookup resolves to the
 *  first tag, so a second dimension with that id would show the first one's
 *  data in every widget: the editor must refuse it, naming both keys. */

const COST_CENTER: TagDimension = { tagName: 'cost-center', label: 'Cost Center' };
const TEAM: TagDimension = { tagName: 'team', label: 'Team' };

function renderView(tags: readonly TagDimension[]) {
  const api = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({
    builtIn: [{ name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' }],
    tags: [...tags],
  });
  vi.spyOn(api, 'discoverTagKeys').mockResolvedValue({
    tags: ['cost-center', 'cost_center', 'team', 'owner'].map(key => ({
      key, sampleValues: [], rowCount: 10, distinctCount: 2, coveragePct: 50,
    })),
    samplePeriod: '2026-04',
  });
  const saveSpy = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { saveSpy, user };
}

const CONFLICT = /tag "cost_center" maps to the same dimension id \(tag_cost_center\) as tag "cost-center"/;

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Save' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DimensionsView — tags sharing a dimension id', () => {
  it('refuses to add a tag whose id another tag already has, naming both keys', async () => {
    const { user } = renderView([COST_CENTER]);
    await user.click(await screen.findByRole('button', { name: '+ Add' }));
    const resourceTag = await screen.findByDisplayValue('No resource tag');
    await waitFor(() => { expect(within(resourceTag).getByRole('option', { name: 'cost_center' })).toBeDefined(); });

    await user.selectOptions(resourceTag, 'cost_center');
    expect(screen.getByText(CONFLICT)).toBeDefined();
    expect(saveButton()).toHaveProperty('disabled', true);

    await user.click(saveButton());
    // Still editing, and no cost_center dimension was added.
    expect(screen.getByText(CONFLICT)).toBeDefined();
    expect(screen.getAllByRole('button', { name: /tag:cost/ })).toHaveLength(1);

    // A key with its own id clears the refusal.
    await user.selectOptions(resourceTag, 'owner');
    expect(screen.queryByText(CONFLICT)).toBeNull();
    expect(saveButton()).toHaveProperty('disabled', false);
    await user.click(saveButton());
    await waitFor(() => { expect(screen.getAllByRole('button', { name: /tag:owner/ })).toHaveLength(1); });
  });

  it('refuses to save an edit that gives a tag another tag\'s id', async () => {
    const { user } = renderView([COST_CENTER, TEAM]);
    await user.click(await screen.findByRole('button', { name: /tag:team/ }));
    const resourceTag = await screen.findByDisplayValue('team');
    await waitFor(() => { expect(within(resourceTag).getByRole('option', { name: 'cost_center' })).toBeDefined(); });

    // Saving the tag unchanged is fine: it doesn't collide with itself.
    expect(saveButton()).toHaveProperty('disabled', false);

    await user.selectOptions(resourceTag, 'cost_center');
    expect(screen.getByText(CONFLICT)).toBeDefined();
    expect(saveButton()).toHaveProperty('disabled', true);
  });

  it('flags a loaded config whose tags share an id and blocks Apply until one is removed', async () => {
    // How the validator hands such a config over: the later tag disabled.
    const duplicate: TagDimension = { tagName: 'cost_center', label: 'Cost center (new)', enabled: false };
    const { saveSpy, user } = renderView([COST_CENTER, duplicate]);

    const banner = await screen.findByRole('alert');
    expect(within(banner).getByText(/"Cost Center" \(tag "cost-center"\) and "Cost center \(new\)" \(tag "cost_center"\) share the dimension id tag_cost_center/)).toBeDefined();

    // Any edit leaves Apply refused while the clash remains.
    await user.click(screen.getByRole('button', { name: 'Resource' }));
    const apply = await screen.findByRole('button', { name: /Apply & rebuild/i });
    expect(apply).toHaveProperty('disabled', true);
    await user.click(apply);
    expect(saveSpy).not.toHaveBeenCalled();

    await user.click(within(banner).getByRole('button', { name: 'Remove "Cost center (new)"' }));
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: /Apply & rebuild/i }));
    await waitFor(() => { expect(saveSpy).toHaveBeenCalledTimes(1); });
    expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ tags: [COST_CENTER] }));
  });
});
