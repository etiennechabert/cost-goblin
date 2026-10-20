import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId, tagSqlColumn } from '@costgoblin/core/browser';
import type { BuiltInDimension, CostApi, DimensionsConfig, RollupDimEstimate, RollupGrainEstimate, TagDimension } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';
import { setReducedMotion } from './setup.js';

/** Reviewing dimensions one by one: an open editor can turn its dimension off,
 *  which opens the next one in the list, and a name in the Rollup impact panel
 *  opens that dimension's editor. An editor opened from elsewhere than its own
 *  row is scrolled into view and takes the focus. */

const SERVICE: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };
const REGION: BuiltInDimension = { name: asDimensionId('region'), label: 'Region', field: 'region' };
const CHARGE: BuiltInDimension = { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' };
const TEAM: TagDimension = { tagName: 'team', label: 'Team' };
const ENV: TagDimension = { tagName: 'env', label: 'Environment' };

const CONFIG: DimensionsConfig = { builtIn: [SERVICE, REGION, CHARGE], tags: [TEAM, ENV] };

function dim(column: string, over: Partial<RollupDimEstimate> = {}): RollupDimEstimate {
  return { column, cardinality: 10, rawOnly: false, marginalMultiplier: 1.5, marginalRows: 0, impactShare: 0.25, outlier: false, ...over };
}

function estimate(dims: readonly RollupDimEstimate[]): RollupGrainEstimate {
  return {
    probePeriod: '2026-04',
    months: 12,
    lineItems: 100_000,
    raw: { rows: 1_200_000, bytes: 400_000_000 },
    current: null,
    currentMatchesCandidate: false,
    candidate: { rows: 120_000, bytes: 2_000_000, rebuildSeconds: 42, perPartitionBytes: 2_000_000, sizeBand: 'tiny', rebuildBand: 'fast', growthFactor: null },
    compressionRate: 10,
    rawOnly: { recommended: false, reason: null },
    dims,
  };
}

function renderView(dims: readonly RollupDimEstimate[] = []) {
  const api: CostApi = new MockCostApi();
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(CONFIG);
  vi.spyOn(api, 'estimateRollupGrain').mockResolvedValue(estimate(dims));
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { save, scroll, user };
}

function enabledSection(): HTMLElement {
  const section = screen.getByRole('heading', { name: /^Enabled dimensions/ }).parentElement;
  if (section === null) throw new Error('no enabled-dimensions list');
  return section;
}

/** The labels of the enabled-list rows still collapsed (the open editor is
 *  not draggable), top to bottom. */
function rowLabels(): string[] {
  return [...enabledSection().children].filter(r => r.hasAttribute('draggable')).map(r => r.querySelector('span')?.textContent ?? '');
}

async function openRow(user: ReturnType<typeof userEvent.setup>, label: string): Promise<void> {
  await screen.findByRole('heading', { name: /^Enabled dimensions/ });
  const row = within(enabledSection()).getByRole('button', { name: new RegExp(`^${label}`) });
  await user.click(row);
  expect(screen.getByLabelText('Display Label')).toHaveProperty('value', label);
}

/** The open editor: the card around its Display Label field. */
function openEditor(): HTMLElement {
  const card = screen.getByLabelText('Display Label').closest('[tabindex="-1"]');
  if (!(card instanceof HTMLElement)) throw new Error('no open editor');
  return card;
}

function disableButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Disable dimension' });
}

function pillTitle(name: string): string | null {
  const list = screen.getByRole('heading', { name: 'Built-in dimensions' }).nextElementSibling;
  if (!(list instanceof HTMLElement)) throw new Error('no built-in pills');
  return within(list).getByRole('button', { name }).getAttribute('title');
}

function impactPanel(): HTMLElement {
  const box = screen.getByRole('heading', { name: 'Rollup impact' }).closest('.rounded-xl');
  if (!(box instanceof HTMLElement)) throw new Error('no rollup impact panel');
  return box;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('Dimension editor — Disable dimension', () => {
  it('turns the dimension off and opens the next one, built-in or tag, until the last', async () => {
    const { save, scroll, user } = renderView();
    await waitFor(() => { expect(rowLabels()).toEqual(['Service', 'Region', 'Charge Category', 'Team', 'Environment']); });
    await openRow(user, 'Region');
    // Opened from its own row: already where the user looks.
    expect(scroll).not.toHaveBeenCalled();
    expect(disableButton().getAttribute('title')).toBe('Turn this dimension off and open Charge Category');

    await user.click(disableButton());
    expect(pillTitle('Region')).toBe('Click to enable');
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Charge Category');
    expect(rowLabels()).toEqual(['Service', 'Team', 'Environment']);
    // The next editor is brought into view and holds the focus.
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(openEditor());
    expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'smooth' });
    expect(document.activeElement).toBe(openEditor());

    await user.click(disableButton());
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Team');
    await user.click(disableButton());
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Environment');
    // The last dimension has no next one: the editor just closes, and the
    // focus stays in the list.
    expect(disableButton().getAttribute('title')).toBe('Turn this dimension off');
    await user.click(disableButton());
    expect(screen.queryByLabelText('Display Label')).toBeNull();
    expect(rowLabels()).toEqual(['Service']);
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: /^Enabled dimensions/ }));

    await user.click(await screen.findByRole('button', { name: /Apply & rebuild/ }));
    await waitFor(() => { expect(save).toHaveBeenCalledTimes(1); });
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.builtIn.map(d => d.enabled)).toEqual([undefined, false, false]);
    expect(saved?.tags.map(t => t.enabled)).toEqual([false, false]);
    expect(saved?.order).toEqual(['builtin:service']);
  });

  it('scrolls without animation when the OS asks for reduced motion', async () => {
    setReducedMotion(true);
    const { scroll, user } = renderView();
    await openRow(user, 'Region');
    await user.click(disableButton());
    expect(scroll).toHaveBeenLastCalledWith({ block: 'start', behavior: 'auto' });
  });

  it('is not offered for a dimension that cannot be turned off, nor in the Add form', async () => {
    const { user } = renderView();
    await openRow(user, 'Service');
    expect(screen.queryByRole('button', { name: 'Disable dimension' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: '+ Add' }));
    expect(screen.getByText('Resource Tag', { exact: true })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Disable dimension' })).toBeNull();
  });

  it('asks before dropping the editor’s unsaved edits: Keep editing keeps the dimension on', async () => {
    const { user } = renderView();
    await openRow(user, 'Region');
    await user.type(screen.getByLabelText('Description'), 'draft note');

    await user.click(disableButton());
    const dialog = await screen.findByRole('dialog', { name: 'Disable this dimension?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByLabelText('Description')).toHaveProperty('value', 'draft note');
    expect(pillTitle('Region')).toBe('Click to disable');

    await user.click(disableButton());
    const again = await screen.findByRole('dialog', { name: 'Disable this dimension?' });
    await user.click(within(again).getByRole('button', { name: 'Disable' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(pillTitle('Region')).toBe('Click to enable');
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Charge Category');
    // The discarded edit never reached the draft.
    expect(screen.queryByText('draft note')).toBeNull();
  });
});

describe('Rollup impact — dimension names', () => {
  it('open that dimension’s editor and bring it into view, again when asked again', async () => {
    const { scroll, user } = renderView([
      dim('region', { outlier: true, marginalMultiplier: 16.3, marginalRows: 1_600_000, impactShare: 0.9 }),
      dim(tagSqlColumn(TEAM)),
      dim('usage_type'),
    ]);
    await screen.findByRole('heading', { name: 'Rollup impact' });
    const region = await within(impactPanel()).findAllByRole('button', { name: 'Region' });
    // The per-dimension list and the outlier warning both name it.
    expect(region).toHaveLength(2);
    // A column no enabled dimension has stays plain text.
    expect(within(impactPanel()).queryByRole('button', { name: 'usage_type' })).toBeNull();
    expect(within(impactPanel()).getByText('usage_type')).toBeDefined();

    await user.click(within(impactPanel()).getByRole('button', { name: 'Team' }));
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Team');
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(openEditor());

    const [listName, warningName] = region;
    if (listName === undefined || warningName === undefined) throw new Error('missing Region names');
    await user.click(listName);
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Region');
    expect(scroll).toHaveBeenCalledTimes(2);
    // With its editor still open (a key press, unlike a click, doesn't close
    // it first), the warning's name scrolls back to it.
    warningName.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByLabelText('Display Label')).toHaveProperty('value', 'Region');
    expect(scroll).toHaveBeenCalledTimes(3);
    expect(scroll.mock.contexts[2]).toBe(openEditor());
  });
});
