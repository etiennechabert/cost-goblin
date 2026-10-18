import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { asDimensionId, OVERVIEW_SEED_VIEW } from '@costgoblin/core/browser';
import type { Dimension, WidgetSpec, WidgetType } from '@costgoblin/core/browser';
import { WidgetInspector } from '../components/widget-inspector.js';
import { WIDGET_CATALOG } from '../widgets/registry.js';

const SERVICE = asDimensionId('service');
const REGION = asDimensionId('region');

const DIMS: readonly Dimension[] = [
  { name: SERVICE, label: 'Service', field: 'service' },
  { name: REGION, label: 'Region', field: 'region' },
  { tagName: 'team', label: 'Team', concept: 'owner' },
];

const SEED_TABLE = OVERVIEW_SEED_VIEW.rows.flatMap(r => r.widgets).find(w => w.type === 'table');
const SEED_COLUMNS = SEED_TABLE?.type === 'table' ? (SEED_TABLE.enabledColumns ?? []) : [];

interface HarnessProps {
  readonly initial: WidgetSpec;
  readonly dimensions: readonly Dimension[];
  readonly onChange: (next: WidgetSpec) => void;
  readonly onDelete: () => void;
  readonly onMoveLeft?: (() => void) | undefined;
  readonly onMoveRight?: (() => void) | undefined;
}

/** The inspector is controlled: the views editor owns the spec and feeds each
 *  edit back in. Mirror that so multi-step edits build on each other. */
function Harness({ initial, dimensions, onChange, onDelete, onMoveLeft, onMoveRight }: HarnessProps) {
  const [widget, setWidget] = useState<WidgetSpec>(initial);
  return (
    <WidgetInspector
      widget={widget}
      dimensions={dimensions}
      onChange={(next) => { onChange(next); setWidget(next); }}
      onDelete={onDelete}
      onMoveLeft={onMoveLeft}
      onMoveRight={onMoveRight}
    />
  );
}

interface SetupOptions {
  readonly dimensions?: readonly Dimension[];
  readonly onMoveLeft?: () => void;
  readonly onMoveRight?: () => void;
}

function setup(initial: WidgetSpec, opts: SetupOptions = {}) {
  const onChange = vi.fn<(next: WidgetSpec) => void>();
  const onDelete = vi.fn<() => void>();
  const user = userEvent.setup();
  render(
    <Harness
      initial={initial}
      dimensions={opts.dimensions ?? DIMS}
      onChange={onChange}
      onDelete={onDelete}
      onMoveLeft={opts.onMoveLeft}
      onMoveRight={opts.onMoveRight}
    />,
  );
  function lastChange(): WidgetSpec {
    const call = onChange.mock.lastCall;
    if (call === undefined) throw new Error('onChange was never called');
    return call[0];
  }
  return { onChange, onDelete, user, lastChange };
}

function catalogLabel(type: WidgetType): string {
  const entry = WIDGET_CATALOG.find(c => c.type === type);
  if (entry === undefined) throw new Error(`no catalog entry for ${type}`);
  return entry.label;
}

/** The widget-type picker: the select showing the current type's label. */
function typeSelect(type: WidgetType): HTMLElement {
  return screen.getByDisplayValue(catalogLabel(type));
}

/** A segmented-control button (size, bubble scale), found by its text. */
function segment(label: string): HTMLElement {
  return screen.getByText(label, { selector: 'button' });
}

function valueOf(el: HTMLElement): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement) return el.value;
  throw new Error('not a form control');
}

/** A row of the table-columns editor: the checkbox next to a column label. */
function columnCheckbox(label: string): HTMLInputElement {
  const row = screen.getByText(label, { selector: 'span' }).parentElement;
  if (row === null) throw new Error(`no row for column ${label}`);
  const box = within(row).getByRole('checkbox');
  if (!(box instanceof HTMLInputElement)) throw new Error('checkbox is not an input');
  return box;
}

describe('WidgetInspector — header controls', () => {
  it('offers move buttons only when the editor can move the widget', async () => {
    const onMoveLeft = vi.fn<() => void>();
    const onMoveRight = vi.fn<() => void>();
    const { user, onDelete } = setup({ id: 'w', type: 'summary', size: 'small' }, { onMoveLeft, onMoveRight });

    await user.click(screen.getByRole('button', { name: 'Move widget left' }));
    await user.click(screen.getByRole('button', { name: 'Move widget right' }));
    await user.click(screen.getByRole('button', { name: 'Remove widget' }));

    expect(onMoveLeft).toHaveBeenCalledTimes(1);
    expect(onMoveRight).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('hides the move buttons at the edges of a row', () => {
    setup({ id: 'w', type: 'summary', size: 'small' });

    expect(screen.queryByRole('button', { name: 'Move widget left' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Move widget right' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove widget' })).toBeDefined();
  });

  it('highlights the current size and switches to the one clicked', async () => {
    const { user, lastChange } = setup({ id: 'w', type: 'summary', size: 'small' });

    expect(segment('S').className).toContain('bg-bg-tertiary');
    expect(segment('Full').className).not.toContain('bg-bg-tertiary');

    await user.click(segment('Full'));

    expect(lastChange()).toEqual({ id: 'w', type: 'summary', size: 'full' });
    expect(segment('Full').className).toContain('bg-bg-tertiary');
    expect(segment('S').className).not.toContain('bg-bg-tertiary');
  });
});

describe('WidgetInspector — title', () => {
  it('sets a custom title as the user types', async () => {
    const { user, lastChange } = setup({ id: 'w', type: 'pie', size: 'medium', groupBy: SERVICE });

    const input = screen.getByPlaceholderText('Auto');
    expect(valueOf(input)).toBe('');
    await user.type(input, 'Spend');

    expect(lastChange()).toEqual({ id: 'w', type: 'pie', size: 'medium', groupBy: SERVICE, title: 'Spend' });
  });

  // Clearing the title must drop the key (an empty string would render as a
  // blank heading) while keeping every type-specific setting.
  const STRIP_CASES: readonly { readonly name: string; readonly widget: WidgetSpec; readonly expected: WidgetSpec }[] = [
    {
      name: 'summary keeps its metric',
      widget: { id: 'w', type: 'summary', size: 'small', title: 'T', metric: 'delta' },
      expected: { id: 'w', type: 'summary', size: 'small', metric: 'delta' },
    },
    {
      name: 'summary without a metric',
      widget: { id: 'w', type: 'summary', size: 'small', title: 'T' },
      expected: { id: 'w', type: 'summary', size: 'small' },
    },
    {
      name: 'pie keeps a hidden legend',
      widget: { id: 'w', type: 'pie', size: 'medium', title: 'T', groupBy: SERVICE, showLegend: false },
      expected: { id: 'w', type: 'pie', size: 'medium', groupBy: SERVICE, showLegend: false },
    },
    {
      name: 'pie drops a legend left at its default',
      widget: { id: 'w', type: 'pie', size: 'medium', title: 'T', groupBy: SERVICE, showLegend: true },
      expected: { id: 'w', type: 'pie', size: 'medium', groupBy: SERVICE },
    },
    {
      name: 'stacked bar',
      widget: { id: 'w', type: 'stackedBar', size: 'large', title: 'T', groupBy: REGION },
      expected: { id: 'w', type: 'stackedBar', size: 'large', groupBy: REGION },
    },
    {
      name: 'pareto',
      widget: { id: 'w', type: 'pareto', size: 'large', title: 'T', groupBy: REGION },
      expected: { id: 'w', type: 'pareto', size: 'large', groupBy: REGION },
    },
    {
      name: 'bubble keeps scale and thresholds',
      widget: { id: 'w', type: 'bubble', size: 'large', title: 'T', groupBy: SERVICE, logScale: 2, deltaThreshold: 50, percentThreshold: 5 },
      expected: { id: 'w', type: 'bubble', size: 'large', groupBy: SERVICE, logScale: 2, deltaThreshold: 50, percentThreshold: 5 },
    },
    {
      name: 'bubble without optional settings',
      widget: { id: 'w', type: 'bubble', size: 'large', title: 'T', groupBy: SERVICE },
      expected: { id: 'w', type: 'bubble', size: 'large', groupBy: SERVICE },
    },
    {
      name: 'treemap keeps its drill-down',
      widget: { id: 'w', type: 'treemap', size: 'large', title: 'T', groupBy: SERVICE, drillTo: REGION },
      expected: { id: 'w', type: 'treemap', size: 'large', groupBy: SERVICE, drillTo: REGION },
    },
    {
      name: 'treemap without a drill-down',
      widget: { id: 'w', type: 'treemap', size: 'large', title: 'T', groupBy: SERVICE },
      expected: { id: 'w', type: 'treemap', size: 'large', groupBy: SERVICE },
    },
    {
      name: 'line keeps its top N',
      widget: { id: 'w', type: 'line', size: 'large', title: 'T', groupBy: SERVICE, topN: 4 },
      expected: { id: 'w', type: 'line', size: 'large', groupBy: SERVICE, topN: 4 },
    },
    {
      name: 'top-N bar without a top N',
      widget: { id: 'w', type: 'topNBar', size: 'large', title: 'T', groupBy: SERVICE },
      expected: { id: 'w', type: 'topNBar', size: 'large', groupBy: SERVICE },
    },
    {
      name: 'heatmap',
      widget: { id: 'w', type: 'heatmap', size: 'large', title: 'T', groupBy: SERVICE, topN: 3 },
      expected: { id: 'w', type: 'heatmap', size: 'large', groupBy: SERVICE, topN: 3 },
    },
    {
      name: 'waterfall',
      widget: { id: 'w', type: 'waterfall', size: 'large', title: 'T', groupBy: SERVICE, topN: 5 },
      expected: { id: 'w', type: 'waterfall', size: 'large', groupBy: SERVICE, topN: 5 },
    },
    {
      name: 'price vs volume',
      widget: { id: 'w', type: 'priceVolume', size: 'large', title: 'T', groupBy: SERVICE, topN: 6 },
      expected: { id: 'w', type: 'priceVolume', size: 'large', groupBy: SERVICE, topN: 6 },
    },
    {
      name: 'burndown keeps its budget',
      widget: { id: 'w', type: 'burndown', size: 'large', title: 'T', budget: 900 },
      expected: { id: 'w', type: 'burndown', size: 'large', budget: 900 },
    },
    {
      name: 'burndown without a budget',
      widget: { id: 'w', type: 'burndown', size: 'large', title: 'T' },
      expected: { id: 'w', type: 'burndown', size: 'large' },
    },
    {
      name: 'table keeps its columns',
      widget: { id: 'w', type: 'table', size: 'full', title: 'T', enabledColumns: ['cost'] },
      expected: { id: 'w', type: 'table', size: 'full', enabledColumns: ['cost'] },
    },
    {
      name: 'table without explicit columns',
      widget: { id: 'w', type: 'table', size: 'full', title: 'T' },
      expected: { id: 'w', type: 'table', size: 'full' },
    },
    {
      name: 'baseline keeps its top N',
      widget: { id: 'w', type: 'baseline', size: 'large', title: 'T', topN: 3 },
      expected: { id: 'w', type: 'baseline', size: 'large', topN: 3 },
    },
    {
      name: 'baseline without a top N',
      widget: { id: 'w', type: 'baseline', size: 'large', title: 'T' },
      expected: { id: 'w', type: 'baseline', size: 'large' },
    },
  ];

  it.each(STRIP_CASES)('clearing the title — $name', async ({ widget, expected }) => {
    const { user, lastChange } = setup(widget);

    const input = screen.getByPlaceholderText('Auto');
    expect(valueOf(input)).toBe('T');
    await user.clear(input);

    const next = lastChange();
    expect(next).toStrictEqual(expected);
    expect('title' in next).toBe(false);
  });
});

describe('WidgetInspector — switching widget type', () => {
  const FROM_PIE: WidgetSpec = { id: 'w', type: 'pie', size: 'medium', title: 'Mine', groupBy: REGION, showLegend: false };

  // Each new type starts from its defaults, carrying over only the id, size,
  // title and (when the new type takes one) the group-by dimension.
  const DEFAULT_CASES: readonly { readonly to: WidgetType; readonly expected: WidgetSpec }[] = [
    { to: 'summary', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'summary' } },
    { to: 'stackedBar', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'stackedBar', groupBy: REGION } },
    { to: 'pareto', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'pareto', groupBy: REGION } },
    { to: 'bubble', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'bubble', groupBy: REGION } },
    { to: 'treemap', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'treemap', groupBy: REGION } },
    { to: 'line', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'line', groupBy: REGION, topN: 6 } },
    { to: 'topNBar', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'topNBar', groupBy: REGION, topN: 12 } },
    { to: 'heatmap', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'heatmap', groupBy: REGION, topN: 12 } },
    { to: 'waterfall', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'waterfall', groupBy: REGION, topN: 8 } },
    { to: 'priceVolume', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'priceVolume', groupBy: REGION, topN: 6 } },
    { to: 'burndown', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'burndown' } },
    { to: 'table', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'table', enabledColumns: [...SEED_COLUMNS] } },
    { to: 'baseline', expected: { id: 'w', size: 'medium', title: 'Mine', type: 'baseline', topN: 8 } },
  ];

  it.each(DEFAULT_CASES)('pie → $to starts from defaults', async ({ to, expected }) => {
    const { user, lastChange } = setup(FROM_PIE);

    await user.selectOptions(typeSelect('pie'), catalogLabel(to));

    expect(lastChange()).toStrictEqual(expected);
  });

  it('turns another grouped chart into a pie with the legend at its default', async () => {
    const { user, lastChange } = setup({ id: 'w', type: 'treemap', size: 'large', title: 'Mine', groupBy: REGION, drillTo: SERVICE });

    await user.selectOptions(typeSelect('treemap'), catalogLabel('pie'));

    expect(lastChange()).toStrictEqual({ id: 'w', size: 'large', title: 'Mine', type: 'pie', groupBy: REGION });
  });

  it('keeps an existing top N when moving between ranked widgets', async () => {
    const { user, lastChange } = setup({ id: 'w', type: 'line', size: 'large', groupBy: SERVICE, topN: 4 });

    await user.selectOptions(typeSelect('line'), catalogLabel('topNBar'));
    expect(lastChange()).toStrictEqual({ id: 'w', size: 'large', type: 'topNBar', groupBy: SERVICE, topN: 4 });

    await user.selectOptions(typeSelect('topNBar'), catalogLabel('baseline'));
    expect(lastChange()).toStrictEqual({ id: 'w', size: 'large', type: 'baseline', topN: 4 });
  });

  it('keeps the log scale but resets thresholds when the bubble type is applied again', () => {
    const { lastChange } = setup({ id: 'w', type: 'bubble', size: 'large', groupBy: SERVICE, logScale: 2, deltaThreshold: 9, percentThreshold: 3 });

    // Only a change event carrying the current type gets here (a user can't
    // re-pick the selected option); the scale is the one setting carried over.
    fireEvent.change(typeSelect('bubble'), { target: { value: 'bubble' } });

    expect(lastChange()).toStrictEqual({ id: 'w', size: 'large', type: 'bubble', groupBy: SERVICE, logScale: 2 });
  });

  it('groups a new chart by the first configured dimension when the old widget had none', async () => {
    // DIMS already holds the team tag, and the validator lets no two dimensions
    // share tag_team (it disables the second on load and refuses it on save):
    // move it to the front instead.
    const tagFirst: readonly Dimension[] = [
      { tagName: 'team', label: 'Team', concept: 'owner' },
      { name: SERVICE, label: 'Service', field: 'service' },
      { name: REGION, label: 'Region', field: 'region' },
    ];
    const { user, lastChange } = setup({ id: 'w', type: 'summary', size: 'small' }, { dimensions: tagFirst });

    await user.selectOptions(typeSelect('summary'), catalogLabel('pie'));

    expect(lastChange()).toStrictEqual({ id: 'w', size: 'small', type: 'pie', groupBy: asDimensionId('tag_team') });
  });

  it('falls back to grouping by service when no dimensions are configured', async () => {
    const { user, lastChange } = setup({ id: 'w', type: 'burndown', size: 'small' }, { dimensions: [] });

    await user.selectOptions(typeSelect('burndown'), catalogLabel('treemap'));

    expect(lastChange()).toStrictEqual({ id: 'w', size: 'small', type: 'treemap', groupBy: SERVICE });
  });

  it('ignores a value that is not a known widget type', () => {
    const { onChange } = setup({ id: 'w', type: 'summary', size: 'small' });

    fireEvent.change(typeSelect('summary'), { target: { value: 'not-a-widget' } });

    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('WidgetInspector — group by', () => {
  it('lists the configured dimensions and regroups the chart', async () => {
    const { user, lastChange } = setup({ id: 'w', type: 'pie', size: 'medium', groupBy: SERVICE });

    const select = screen.getByRole('combobox', { name: 'Group by' });
    const options = within(select).getAllByRole('option').map(o => o.textContent);
    expect(options).toEqual(['Service', 'Region', 'Team']);
    expect(valueOf(select)).toBe('service');

    await user.selectOptions(select, 'Team');

    expect(lastChange()).toStrictEqual({ id: 'w', type: 'pie', size: 'medium', groupBy: asDimensionId('tag_team') });
  });

  it.each<WidgetSpec>([
    { id: 'w', type: 'summary', size: 'small' },
    { id: 'w', type: 'table', size: 'full' },
    { id: 'w', type: 'burndown', size: 'large' },
  ])('has no group-by picker for $type', (widget) => {
    setup(widget);
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();
  });
});

describe('WidgetInspector — pie legend toggle', () => {
  it('hides the legend, then restores the default', async () => {
    const { user, lastChange } = setup({ id: 'p', type: 'pie', size: 'medium', groupBy: SERVICE });

    const toggle = screen.getByRole('button', { name: 'Legend' });
    expect(toggle.className).toContain('bg-accent');

    await user.click(toggle);
    expect(lastChange()).toStrictEqual({ id: 'p', type: 'pie', size: 'medium', groupBy: SERVICE, showLegend: false });
    expect(screen.getByRole('button', { name: 'Legend' }).className).toContain('bg-bg-tertiary');

    await user.click(screen.getByRole('button', { name: 'Legend' }));
    const restored = lastChange();
    expect(restored.type === 'pie' ? restored.showLegend : 'not a pie').toBeUndefined();
    expect(screen.getByRole('button', { name: 'Legend' }).className).toContain('bg-accent');
  });

  it('is only offered for pies', () => {
    setup({ id: 'w', type: 'treemap', size: 'medium', groupBy: SERVICE });
    expect(screen.queryByRole('button', { name: 'Legend' })).toBeNull();
  });
});

describe('WidgetInspector — bubble settings', () => {
  const BUBBLE: WidgetSpec = { id: 'b', type: 'bubble', size: 'large', groupBy: SERVICE };

  it('defaults to log-10 and switches the scale', async () => {
    const { user, lastChange } = setup(BUBBLE);

    expect(segment('Log 10').className).toContain('bg-bg-tertiary');
    expect(segment('Linear').className).not.toContain('bg-bg-tertiary');

    await user.click(segment('Linear'));
    expect(lastChange()).toStrictEqual({ ...BUBBLE, logScale: 'linear' });
    expect(segment('Linear').className).toContain('bg-bg-tertiary');

    await user.click(segment('Log 2'));
    expect(lastChange()).toStrictEqual({ ...BUBBLE, logScale: 2 });
  });

  it('accepts non-negative thresholds and ignores invalid ones', () => {
    const { onChange, lastChange } = setup({ ...BUBBLE, deltaThreshold: 10, percentThreshold: 2 });

    const minDollars = screen.getByRole('spinbutton', { name: 'Min $' });
    const minPercent = screen.getByRole('spinbutton', { name: 'Min %' });
    expect(valueOf(minDollars)).toBe('10');
    expect(valueOf(minPercent)).toBe('2');

    fireEvent.change(minDollars, { target: { value: '25.5' } });
    expect(lastChange()).toStrictEqual({ ...BUBBLE, deltaThreshold: 25.5, percentThreshold: 2 });

    fireEvent.change(minPercent, { target: { value: '7' } });
    expect(lastChange()).toStrictEqual({ ...BUBBLE, deltaThreshold: 25.5, percentThreshold: 7 });

    const calls = onChange.mock.calls.length;
    fireEvent.change(minDollars, { target: { value: '-3' } });
    fireEvent.change(minPercent, { target: { value: '-1' } });
    fireEvent.change(minDollars, { target: { value: '' } });
    fireEvent.change(minPercent, { target: { value: '' } });
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('shows zero thresholds when none are set', () => {
    setup(BUBBLE);
    expect(valueOf(screen.getByRole('spinbutton', { name: 'Min $' }))).toBe('0');
    expect(valueOf(screen.getByRole('spinbutton', { name: 'Min %' }))).toBe('0');
  });
});

describe('WidgetInspector — top N', () => {
  const RANKED: readonly WidgetSpec[] = [
    { id: 'w', type: 'line', size: 'large', groupBy: SERVICE },
    { id: 'w', type: 'topNBar', size: 'large', groupBy: SERVICE },
    { id: 'w', type: 'heatmap', size: 'large', groupBy: SERVICE },
    { id: 'w', type: 'baseline', size: 'large' },
    { id: 'w', type: 'waterfall', size: 'large', groupBy: SERVICE },
    { id: 'w', type: 'priceVolume', size: 'large', groupBy: SERVICE },
  ];

  it.each(RANKED)('sets a positive top N on $type', (widget) => {
    const { lastChange } = setup(widget);

    const input = screen.getByRole('spinbutton', { name: 'Top N' });
    fireEvent.change(input, { target: { value: '7' } });

    expect(lastChange()).toStrictEqual({ ...widget, topN: 7 });
    expect(valueOf(screen.getByRole('spinbutton', { name: 'Top N' }))).toBe('7');
  });

  it('shows the saved value and rejects zero or empty input', () => {
    const { onChange } = setup({ id: 'w', type: 'line', size: 'large', groupBy: SERVICE, topN: 3 });

    const input = screen.getByRole('spinbutton', { name: 'Top N' });
    expect(valueOf(input)).toBe('3');
    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.change(input, { target: { value: '' } });

    expect(onChange).not.toHaveBeenCalled();
  });

  it.each<WidgetSpec>([
    { id: 'w', type: 'pie', size: 'large', groupBy: SERVICE },
    { id: 'w', type: 'summary', size: 'large' },
  ])('has no top N field for $type', (widget) => {
    setup(widget);
    expect(screen.queryByRole('spinbutton', { name: 'Top N' })).toBeNull();
  });
});

describe('WidgetInspector — burndown budget', () => {
  it('edits the budget and ignores negative values', () => {
    const { onChange, lastChange } = setup({ id: 'b', type: 'burndown', size: 'large' });

    const input = screen.getByRole('spinbutton', { name: 'Budget $' });
    expect(valueOf(input)).toBe('0');

    fireEvent.change(input, { target: { value: '5000' } });
    expect(lastChange()).toStrictEqual({ id: 'b', type: 'burndown', size: 'large', budget: 5000 });
    expect(valueOf(screen.getByRole('spinbutton', { name: 'Budget $' }))).toBe('5000');

    fireEvent.change(input, { target: { value: '-5' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

describe('WidgetInspector — table columns', () => {
  it('starts from the seed columns and marks tag columns', () => {
    setup({ id: 't', type: 'table', size: 'full' });

    expect(SEED_COLUMNS.length).toBeGreaterThan(0);
    expect(columnCheckbox('Cost').checked).toBe(true);
    expect(columnCheckbox('Resource').checked).toBe(true);
    expect(columnCheckbox('Description').checked).toBe(true);
    expect(columnCheckbox('Service').checked).toBe(false);
    expect(columnCheckbox('Team').checked).toBe(false);

    // Only the tag dimension's column carries the "tag" badge.
    const teamRow = screen.getByText('Team', { selector: 'span' }).parentElement;
    const serviceRow = screen.getByText('Service', { selector: 'span' }).parentElement;
    if (teamRow === null || serviceRow === null) throw new Error('column rows missing');
    expect(within(teamRow).getByText('tag')).toBeDefined();
    expect(within(serviceRow).queryByText('tag')).toBeNull();
    // A checked column's label is emphasised, an unchecked one is muted.
    expect(screen.getByText('Cost', { selector: 'span' }).className).toContain('text-text-primary');
    expect(screen.getByText('Service', { selector: 'span' }).className).toContain('text-text-muted');
  });

  it('toggles individual columns on and off', async () => {
    const { user, lastChange } = setup({ id: 't', type: 'table', size: 'full', enabledColumns: ['cost'] });

    await user.click(columnCheckbox('Service'));
    expect(lastChange()).toStrictEqual({ id: 't', type: 'table', size: 'full', enabledColumns: ['cost', 'service'] });

    await user.click(columnCheckbox('Cost'));
    expect(lastChange()).toStrictEqual({ id: 't', type: 'table', size: 'full', enabledColumns: ['service'] });
    expect(columnCheckbox('Cost').checked).toBe(false);
  });

  it('deselects everything, selects everything back, and resets to the seed', async () => {
    const { user, lastChange } = setup({ id: 't', type: 'table', size: 'full', enabledColumns: ['cost', 'service'] });

    await user.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(lastChange()).toStrictEqual({ id: 't', type: 'table', size: 'full', enabledColumns: [] });

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    const all = lastChange();
    const allColumns = all.type === 'table' ? all.enabledColumns : undefined;
    expect(allColumns).toContain('tag_team');
    expect(allColumns).toContain('usage_date');
    expect(allColumns).not.toContain('usage_hour');
    expect(columnCheckbox('Region').checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Deselect all' })).toBeDefined();

    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(lastChange()).toStrictEqual({ id: 't', type: 'table', size: 'full', enabledColumns: [...SEED_COLUMNS] });
  });
});
