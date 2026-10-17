import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { AliasSuggestion, BuiltInDimension, ColumnValuesPreview, CostApi, DimensionsConfig } from '@costgoblin/core/browser';
import { MockCostApi } from '../__fixtures__/mock-api.js';
import { CostApiProvider } from '../hooks/use-cost-api.js';
import { DimensionsView } from '../views/dimensions.js';

/** The built-in dimension editor: label, description, normalization and alias
 *  rules, the default filter picker, alias suggestions, and the save / cancel /
 *  discard flow back into the Dimensions draft. */

const SERVICE: BuiltInDimension = { name: asDimensionId('service'), label: 'Service', field: 'service' };
const CHARGE: BuiltInDimension = { name: asDimensionId('charge_category'), label: 'Charge Category', field: 'charge_category' };

const NO_ISSUES = { invalid: [], slow: [], skipped: [] };

function preview(values: readonly string[], period = '2026-04'): ColumnValuesPreview {
  return { values: values.map(value => ({ value, cost: 10 })), distinctCount: values.length, period, stripIssues: NO_ISSUES };
}

interface Setup {
  readonly builtIn: readonly BuiltInDimension[];
  readonly preview?: ColumnValuesPreview;
  readonly suggestions?: Readonly<Record<string, AliasSuggestion[]>>;
}

function renderView(setup: Setup) {
  // Typed as the interface so each spy carries the real CostApi signature.
  const api: CostApi = new MockCostApi();
  const config: DimensionsConfig = { builtIn: [...setup.builtIn], tags: [] };
  vi.spyOn(api, 'getDimensionsConfig').mockResolvedValue(config);
  const discover = vi.spyOn(api, 'discoverColumnValues').mockResolvedValue(setup.preview ?? preview(['Usage', 'Tax', 'Credit']));
  const suggestions = setup.suggestions ?? {};
  vi.spyOn(api, 'getAliasSuggestions').mockImplementation((id) => Promise.resolve(suggestions[id] ?? []));
  const save = vi.spyOn(api, 'saveDimensionsConfig');
  const user = userEvent.setup();
  render(
    <CostApiProvider value={api}>
      <DimensionsView />
    </CostApiProvider>,
  );
  return { discover, save, user };
}

/** The row in the enabled-dimensions list: its name carries the dim's field. */
async function openEditor(user: ReturnType<typeof userEvent.setup>, field: string): Promise<void> {
  const row = await waitFor(() => {
    const found = screen.getAllByRole('button').find(b => b.textContent.includes(field));
    if (found === undefined) throw new Error(`${field} row not rendered yet`);
    return found;
  });
  await user.click(row);
  await screen.findByLabelText('Display Label');
}

function aliasTextarea(): HTMLElement {
  return screen.getByLabelText('Alias Rules (canonical: alias1, alias2)');
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

describe('BuiltInEditor — editing a dimension', () => {
  it('saves the label, trimmed description, normalization and parsed alias rules into the draft', async () => {
    const { discover, save, user } = renderView({ builtIn: [CHARGE, SERVICE] });
    await openEditor(user, 'charge_category');

    const label = screen.getByLabelText('Display Label');
    await user.clear(label);
    await user.type(label, 'Charges');
    await user.type(screen.getByLabelText('Description'), '  Usage vs credits  ');
    await user.selectOptions(screen.getByLabelText('Normalization'), 'lowercase');
    // Lines without a colon, a canonical or an alias are ignored.
    await user.type(aliasTextarea(), 'usage: Usage, USAGE{Enter}just text{Enter}lonely:{Enter}: orphan{Enter}credit: Credit');

    // The preview re-runs with the normalization the user picked.
    await waitFor(() => { expect(discover).toHaveBeenLastCalledWith('charge_category', { normalize: 'lowercase' }); });

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.queryByLabelText('Display Label')).toBeNull();
    const row = screen.getAllByRole('button').find(b => b.textContent.includes('charge_category'));
    if (row === undefined) throw new Error('row missing after save');
    expect(within(row).getByText('Charges')).toBeDefined();
    expect(within(row).getByText('lowercase')).toBeDefined();
    expect(within(row).getByText('2 alias rules')).toBeDefined();
    expect(within(row).getByText('Usage vs credits')).toBeDefined();

    const saved = await applyDraft(user, save);
    expect(saved.builtIn[0]).toEqual({
      name: 'charge_category',
      label: 'Charges',
      field: 'charge_category',
      description: 'Usage vs credits',
      normalize: 'lowercase',
      aliases: { usage: ['Usage', 'USAGE'], credit: ['Credit'] },
    });
  });

  it('keeps the original label when the label is cleared, and drops alias text with no rules in it', async () => {
    const { save, user } = renderView({
      builtIn: [{ ...CHARGE, description: 'Billing events', aliases: { usage: ['Usage'] }, defaultFilterValues: ['Usage'] }, SERVICE],
    });
    await openEditor(user, 'charge_category');
    expect(aliasTextarea()).toHaveProperty('value', 'usage: Usage');

    await user.clear(screen.getByLabelText('Display Label'));
    await user.clear(screen.getByLabelText('Description'));
    await user.clear(aliasTextarea());
    await user.type(aliasTextarea(), 'no rules here');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const saved = await applyDraft(user, save);
    // A cleared label falls back to the dimension's own; an empty description
    // and rule-less alias text are dropped rather than saved empty.
    expect(saved.builtIn[0]).toEqual({ name: 'charge_category', label: 'Charge Category', field: 'charge_category', defaultFilterValues: ['Usage'] });
  });

  it('closes at once on Cancel when nothing was edited', async () => {
    const { user } = renderView({ builtIn: [CHARGE, SERVICE] });
    await openEditor(user, 'charge_category');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Display Label')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('asks before discarding edits: Keep editing keeps them, Discard drops them', async () => {
    const { user } = renderView({ builtIn: [CHARGE, SERVICE] });
    await openEditor(user, 'charge_category');
    await user.type(screen.getByLabelText('Description'), 'draft note');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull(); });
    expect(screen.getByLabelText('Description')).toHaveProperty('value', 'draft note');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const again = await screen.findByRole('dialog', { name: 'Discard unsaved changes?' });
    await user.click(within(again).getByRole('button', { name: 'Discard' }));
    await waitFor(() => { expect(screen.queryByLabelText('Description')).toBeNull(); });
    // Nothing reached the draft.
    expect(screen.getByText('Saved')).toBeDefined();
    expect(screen.queryByText('draft note')).toBeNull();
  });

  it('offers only alias rules for the service dimensions, which take no transforms', async () => {
    const { discover, user } = renderView({ builtIn: [SERVICE], preview: preview(['Amazon S3', 'AWS Lambda'], '') });
    await openEditor(user, 'service');
    expect(aliasTextarea()).toBeDefined();
    expect(screen.queryByLabelText('Normalization')).toBeNull();
    expect(screen.queryByLabelText(/Name strip patterns/)).toBeNull();

    // A preview with no period names no source month.
    expect(await screen.findByText('Preview — 2 distinct values')).toBeDefined();
    expect(screen.getByText('Amazon S3')).toBeDefined();
    expect(discover).toHaveBeenCalledWith('service', {});
  });

  it('shows the preview\'s source month', async () => {
    const { user } = renderView({ builtIn: [CHARGE, SERVICE] });
    await openEditor(user, 'charge_category');
    expect(await screen.findByText(/Preview — 3 distinct values\s*\(from 2026-04\)/)).toBeDefined();
  });
});

describe('BuiltInEditor — default filter', () => {
  const VALUES = ['Usage', 'Tax', 'Credit', 'Refund', 'Fee', 'Discount', 'SavingsPlan', 'Support'];

  function picker(name: RegExp): HTMLElement {
    return screen.getByRole('button', { name });
  }

  it('picks default values from the preview, searching once the list is long', async () => {
    const { save, user } = renderView({ builtIn: [CHARGE, SERVICE], preview: preview(VALUES) });
    await openEditor(user, 'charge_category');
    await screen.findByText('SavingsPlan');

    await user.click(picker(/No defaults/));
    const search = screen.getByPlaceholderText('Search…');
    // The search box takes focus as the list opens.
    expect(document.activeElement).toBe(search);
    expect(screen.getAllByRole('checkbox')).toHaveLength(VALUES.length);

    await user.type(search, 'zzz');
    expect(screen.getByText('No matches.')).toBeDefined();
    await user.clear(search);
    await user.type(search, 'SAV');
    expect(screen.getAllByRole('checkbox').map(c => c.parentElement?.textContent)).toEqual(['SavingsPlan']);
    await user.clear(search);

    await user.click(screen.getByRole('checkbox', { name: 'Usage' }));
    await user.click(screen.getByRole('checkbox', { name: 'Tax' }));
    expect(picker(/^Usage, Tax/)).toBeDefined();
    await user.click(screen.getByRole('checkbox', { name: 'Credit' }));
    await user.click(screen.getByRole('checkbox', { name: 'Refund' }));
    expect(picker(/^4 selected/)).toBeDefined();
    // Unticking a value removes just that one.
    await user.click(screen.getByRole('checkbox', { name: 'Credit' }));
    expect(picker(/^Usage, Tax, Refund/)).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    const saved = await applyDraft(user, save);
    expect(saved.builtIn[0]?.defaultFilterValues).toEqual(['Usage', 'Tax', 'Refund']);
  });

  it('clears the selection, and closes on a press elsewhere in the editor', async () => {
    const { user } = renderView({ builtIn: [{ ...CHARGE, defaultFilterValues: ['Usage', 'Tax'] }, SERVICE], preview: preview(['Usage', 'Tax']) });
    await openEditor(user, 'charge_category');
    await user.click(picker(/^Usage, Tax/));
    // Short lists skip the search box.
    expect(screen.queryByPlaceholderText('Search…')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(picker(/No defaults/)).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Clear selection' })).toBeNull();

    fireEvent.mouseDown(screen.getByLabelText('Description'));
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    // The press was inside the editor, which stays open.
    expect(screen.getByLabelText('Display Label')).toBeDefined();
  });

  it('lists a saved default the preview no longer returns, and says when nothing was discovered', async () => {
    const { user } = renderView({ builtIn: [{ ...CHARGE, defaultFilterValues: ['Legacy'] }, SERVICE], preview: preview([]) });
    await openEditor(user, 'charge_category');
    await screen.findByText('Preview — 0 distinct values (from 2026-04)');
    await user.click(picker(/^Legacy/));
    expect(screen.getByRole('checkbox', { name: 'Legacy' })).toHaveProperty('checked', true);

    await user.click(screen.getByRole('checkbox', { name: 'Legacy' }));
    expect(screen.getByText('No discovered values yet.')).toBeDefined();
    // Toggling the picker button closes it again.
    await user.click(picker(/No defaults/));
    expect(screen.queryByText('No discovered values yet.')).toBeNull();
  });
});

describe('BuiltInEditor — alias suggestions', () => {
  it('merges an accepted suggestion into the alias rules, adding to an existing canonical', async () => {
    const { user } = renderView({
      builtIn: [{ ...CHARGE, aliases: { Usage: ['Usage-1'] } }, SERVICE],
      suggestions: {
        charge_category: [
          { canonical: 'Usage', aliases: ['usage', 'Usage-1'] },
          { canonical: 'Credit', aliases: ['credit'] },
        ],
      },
    });
    await openEditor(user, 'charge_category');
    await user.click(await screen.findByRole('button', { name: 'Suggested Aliases (2)' }));

    await user.click(screen.getByRole('button', { name: 'Accept alias suggestion for Usage' }));
    await waitFor(() => { expect(aliasTextarea()).toHaveProperty('value', 'Usage: Usage-1, usage'); });

    // Accepted into empty rules, it starts a new one.
    await user.clear(aliasTextarea());
    await user.click(screen.getByRole('button', { name: 'Accept alias suggestion for Credit' }));
    await waitFor(() => { expect(aliasTextarea()).toHaveProperty('value', 'Credit: credit'); });
  });
});
