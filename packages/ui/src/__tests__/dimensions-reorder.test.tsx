import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { BuiltInDimension, CostApi, DimensionsConfig, TagDimension } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The enabled-dimensions list is one ordered list of built-in and tag
 *  dimensions: reordered with the arrows or by dragging a row by its grip,
 *  reconciled against the saved `order`, and fed by the pills above it. */

const SERVICE: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };
const SERVICE_CATEGORY: BuiltInDimension = { name: asDimensionId('service_category'), label: 'Service Category', field: 'service_category' };
const CHARGE: BuiltInDimension = { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' };
const REGION: BuiltInDimension = { name: asDimensionId('region'), label: 'Region', field: 'region' };
const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
const ENV: TagDimension = { tagName: 'env', label: 'Environment' };

function renderView(config: DimensionsConfig) {
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(config);
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { save, user };
}

function enabledSection(): HTMLElement {
  const section = screen.getByRole('heading', { name: /^Enabled dimensions/ }).parentElement;
  if (section === null) throw new Error('no enabled-dimensions list');
  return section;
}

/** The list's rows, top to bottom (the heading is the section's first child). */
function rows(): HTMLElement[] {
  return [...enabledSection().children].slice(1).filter((r): r is HTMLElement => r instanceof HTMLElement);
}

function rowLabels(): string[] {
  return rows().map(r => r.querySelector('span')?.textContent ?? '');
}

function rowAt(index: number): HTMLElement {
  const found = rows()[index];
  if (found === undefined) throw new Error(`no row ${String(index)}`);
  return found;
}

async function waitForRows(labels: readonly string[]): Promise<void> {
  await waitFor(() => { expect(rowLabels()).toEqual(labels); });
}

function builtInPills(): string[] {
  const list = screen.getByRole('heading', { name: 'Built-in dimensions' }).nextElementSibling;
  if (!(list instanceof HTMLElement)) throw new Error('no built-in pills');
  return within(list).getAllByRole('button').map(b => b.textContent);
}

/** Stand-in for the DataTransfer jsdom lacks; the rows write to it. */
function dataTransfer(): { effectAllowed: string; dropEffect: string; setData: (format: string, data: string) => void } {
  return { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn<(format: string, data: string) => void>() };
}

async function applyDraft(user: ReturnType<typeof userEvent.setup>, save: ReturnType<typeof renderView>['save']): Promise<DimensionsConfig> {
  await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
  await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
  const saved = save.mock.calls[0]?.[0];
  if (saved === undefined) throw new Error('nothing saved');
  return saved;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('Enabled dimensions — reordering', () => {
  it('moves rows with the arrows, across built-in and tag rows, and applies the new order', async () => {
    const { save, user } = renderView({ builtIn: [SERVICE, CHARGE], tags: [TEAM] });
    await waitForRows(['Service', 'Charge Category', 'Team']);
    expect(within(rowAt(0)).getByTitle('Move up')).toHaveProperty('disabled', true);
    expect(within(rowAt(2)).getByTitle('Move down')).toHaveProperty('disabled', true);

    await user.click(within(rowAt(0)).getByTitle('Move down'));
    expect(rowLabels()).toEqual(['Charge Category', 'Service', 'Team']);
    await user.click(within(rowAt(2)).getByTitle('Move up'));
    expect(rowLabels()).toEqual(['Charge Category', 'Team', 'Service']);
    // Moving a row never opens its editor.
    expect(screen.queryByLabelText('Display Label')).toBeNull();

    const config = await applyDraft(user, save);
    expect(config.order).toEqual(['builtin:charge_category', 'tag:team', 'builtin:service']);
  });

  it('drags a row by its grip onto another row', async () => {
    const { save, user } = renderView({ builtIn: [SERVICE, CHARGE], tags: [TEAM] });
    await waitForRows(['Service', 'Charge Category', 'Team']);
    const grip = within(rowAt(0)).getByTitle('Drag to reorder');

    // Only a row held by its grip can be dragged.
    expect(rowAt(0).getAttribute('draggable')).toBe('false');
    fireEvent.mouseDown(grip);
    expect(rowAt(0).getAttribute('draggable')).toBe('true');
    // Releasing another row's grip doesn't drop the hold.
    fireEvent.mouseUp(within(rowAt(1)).getByTitle('Drag to reorder'));
    expect(rowAt(0).getAttribute('draggable')).toBe('true');
    fireEvent.mouseUp(grip);
    expect(rowAt(0).getAttribute('draggable')).toBe('false');

    fireEvent.mouseDown(grip);
    const transfer = dataTransfer();
    fireEvent.dragStart(rowAt(0), { dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe('move');
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', '0');
    // The dragged row dims; the row under it shows where it will land.
    expect(rowAt(0).style.opacity).toBe('0.4');
    const target = rowAt(2);
    expect(fireEvent.dragOver(target, { dataTransfer: transfer })).toBe(false);
    expect(transfer.dropEffect).toBe('move');
    expect(target.style.boxShadow).not.toBe('');

    // Leaving some other row keeps the marker; leaving the target clears it.
    fireEvent.dragLeave(rowAt(1));
    expect(target.style.boxShadow).not.toBe('');
    fireEvent.dragLeave(target);
    expect(target.style.boxShadow).toBe('');

    fireEvent.dragOver(target, { dataTransfer: transfer });
    fireEvent.drop(target, { dataTransfer: transfer });
    expect(rowLabels()).toEqual(['Charge Category', 'Team', 'Service']);
    fireEvent.dragEnd(rowAt(2));
    expect(rows().map(r => r.style.opacity)).toEqual(['', '', '']);
    expect(rows().map(r => r.getAttribute('draggable'))).toEqual(['false', 'false', 'false']);

    const config = await applyDraft(user, save);
    expect(config.order).toEqual(['builtin:charge_category', 'tag:team', 'builtin:service']);
  });

  it('ignores a drag over or a drop on a row when no row is being dragged', async () => {
    renderView({ builtIn: [SERVICE, CHARGE], tags: [TEAM] });
    await waitForRows(['Service', 'Charge Category', 'Team']);
    const transfer = dataTransfer();
    // Not cancelled: the row doesn't offer itself as a drop target.
    expect(fireEvent.dragOver(rowAt(1), { dataTransfer: transfer })).toBe(true);
    expect(rowAt(1).style.boxShadow).toBe('');
    fireEvent.drop(rowAt(1), { dataTransfer: transfer });
    expect(rowLabels()).toEqual(['Service', 'Charge Category', 'Team']);
    expect(screen.getByText('Saved')).toBeDefined();
  });

  it('dropping a row back onto itself changes nothing', async () => {
    renderView({ builtIn: [SERVICE, CHARGE], tags: [TEAM] });
    await waitForRows(['Service', 'Charge Category', 'Team']);
    const transfer = dataTransfer();
    fireEvent.mouseDown(within(rowAt(1)).getByTitle('Drag to reorder'));
    fireEvent.dragStart(rowAt(1), { dataTransfer: transfer });
    // The dragged row is never marked as its own landing spot.
    fireEvent.dragOver(rowAt(1), { dataTransfer: transfer });
    expect(rowAt(1).style.boxShadow).toBe('');
    fireEvent.drop(rowAt(1), { dataTransfer: transfer });
    expect(rowLabels()).toEqual(['Service', 'Charge Category', 'Team']);
    expect(screen.getByText('Saved')).toBeDefined();
  });
});

describe('Enabled dimensions — saved order', () => {
  it('drops stale and duplicate entries from a saved order and appends dims it misses', async () => {
    renderView({
      builtIn: [SERVICE, CHARGE],
      tags: [TEAM, ENV],
      order: ['tag:team', 'builtin:gone', 'tag:team', 'builtin:service'],
    });
    await waitForRows(['Team', 'Service', 'Charge Category', 'Environment']);
    // Reconciling the saved order is not an edit.
    expect(screen.getByText('Saved')).toBeDefined();
  });

  it('lists only enabled dims, in config order, when no order was saved', async () => {
    renderView({
      builtIn: [SERVICE, { ...CHARGE, enabled: false }, REGION],
      tags: [{ ...TEAM, enabled: false }, ENV],
    });
    await waitForRows(['Service', 'Region', 'Environment']);
  });

  it('re-enabling a built-in appends it to the list and saves it enabled', async () => {
    const { save, user } = renderView({ builtIn: [SERVICE, { ...CHARGE, enabled: false }], tags: [ENV] });
    await waitForRows(['Service', 'Environment']);
    const pill = screen.getByRole('button', { name: 'Charge Category' });
    expect(pill.getAttribute('title')).toBe('Click to enable');

    await user.click(pill);
    expect(rowLabels()).toEqual(['Service', 'Environment', 'Charge Category']);
    expect(screen.getByRole('button', { name: 'Charge Category' }).getAttribute('title')).toBe('Click to disable');

    const config = await applyDraft(user, save);
    expect(config.builtIn[1]).toEqual(CHARGE);
    expect(config.order).toEqual(['builtin:service', 'tag:env', 'builtin:charge_category']);
  });
});

describe('Built-in dimension pills — locked dimensions', () => {
  it('re-enables a locked dim saved as disabled, persisting the fix at once', async () => {
    const { save, user } = renderView({
      builtIn: [CHARGE, { ...SERVICE, enabled: false }, { ...SERVICE_CATEGORY, enabled: false }],
      tags: [],
    });
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
    const migrated = save.mock.calls[0]?.[0];
    expect(migrated?.builtIn).toEqual([CHARGE, SERVICE, SERVICE_CATEGORY]);
    // The fix is the new baseline: nothing is left to apply.
    expect(screen.getByText('Saved')).toBeDefined();

    // Locked dims lead the pills and can't be switched off.
    expect(builtInPills()).toEqual(['Service', 'Service Category', 'Charge Category']);
    const servicePill = screen.getByRole('button', { name: 'Service' });
    expect(servicePill.getAttribute('title')).toBe('Always enabled — required for cost breakdown');
    await user.click(servicePill);
    expect(screen.getByText('Saved')).toBeDefined();
    expect(rowLabels()).toContain('Service');
  });

  it('still loads when persisting the fix fails', async () => {
    const api: CostApi = new MockCostApi();
    vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue({ builtIn: [{ ...SERVICE, enabled: false }, CHARGE], tags: [] });
    const save = vi.spyOn(api, 'saveDimensionsConfig').mockRejectedValue(new Error('read-only volume'));
    render(
      <CostApiProvider value={api}>
        <DimensionsView />
      </CostApiProvider>,
    );
    await waitForRows(['Service', 'Charge Category']);
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Couldn’t apply your changes/)).toBeNull();
  });

  it('does not save a config that needs no fix', async () => {
    const { save } = renderView({ builtIn: [SERVICE, CHARGE], tags: [] });
    await waitForRows(['Service', 'Charge Category']);
    expect(save).not.toHaveBeenCalled();
  });
});
