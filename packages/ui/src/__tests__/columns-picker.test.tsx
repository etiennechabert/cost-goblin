import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BASE_COLUMNS,
  ColumnsPicker,
  DataTable,
  TRAILING_COLUMNS,
  applyColumnOrder,
  buildAllColumns,
  filterVisibleColumns,
} from '../components/data-table.js';
import type { ColumnSpec } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';

interface Row {
  readonly service: string;
  readonly region: string;
  readonly team: string;
  readonly cost: number;
}

const COLUMNS: readonly TableColumn<Row>[] = [
  { id: 'service', header: 'Service', dimId: 'service', accessorFn: r => r.service },
  { id: 'region', header: 'Region', dimId: 'region', accessorFn: r => r.region },
  { id: 'tag_team', header: 'Team', dimId: 'tag_team', accessorFn: r => r.team },
  { id: 'cost', header: 'Cost', dimId: null, align: 'right', mono: true, accessorFn: r => r.cost },
];

const ROWS: readonly Row[] = [
  { service: 'Amazon EC2', region: 'eu-west-1', team: 'platform', cost: 120 },
  { service: 'Amazon S3', region: 'us-east-1', team: '', cost: 30 },
];

afterEach(cleanup);

describe('column helpers', () => {
  it('adds the hour column only at hourly granularity, with tags before the trailing columns', () => {
    const tags = [{ id: 'tag_team', label: 'Team' }];
    const daily = buildAllColumns(tags);
    expect(daily.map(c => c.key)).not.toContain('usage_hour');
    expect(daily.slice(-3).map(c => c.key)).toEqual(['tag_team', ...TRAILING_COLUMNS.map(c => c.key)]);
    expect(daily.find(c => c.key === 'tag_team')).toEqual({ key: 'tag_team', label: 'Team', dimId: 'tag_team', align: 'left' });

    const hourly = buildAllColumns(tags, 'hourly');
    expect(hourly.map(c => c.key)).toContain('usage_hour');
    expect(hourly).toHaveLength(BASE_COLUMNS.length + 1 + TRAILING_COLUMNS.length);
  });

  it('orders columns by a saved order, skipping unknown keys and appending the rest', () => {
    const cols: readonly ColumnSpec[] = BASE_COLUMNS.slice(0, 4);
    expect(applyColumnOrder(cols, [])).toEqual(cols);
    expect(applyColumnOrder(cols, [])).not.toBe(cols);
    const ordered = applyColumnOrder(cols, ['cost', 'gone', 'usage_date']);
    expect(ordered.map(c => c.key)).toEqual(['cost', 'usage_date', 'usage_hour', 'list_cost']);
  });

  it('drops hidden and auto-hidden columns', () => {
    const cols = BASE_COLUMNS.slice(0, 4);
    const visible = filterVisibleColumns(cols, new Set(['cost']), new Set(['usage_hour']));
    expect(visible.map(c => c.key)).toEqual(['usage_date', 'list_cost']);
  });
});

function renderPicker(props: { hidden?: readonly string[]; autoHidden?: ReadonlySet<string> } = {}) {
  const onChange = vi.fn<(next: readonly string[]) => void>();
  const onOrderChange = vi.fn<(next: readonly string[]) => void>();
  const user = userEvent.setup();
  render(
    <div>
      <p>outside the picker</p>
      <ColumnsPicker
        allColumns={COLUMNS}
        hiddenColumns={props.hidden ?? []}
        autoHiddenKeys={props.autoHidden ?? new Set()}
        onChange={onChange}
        onOrderChange={onOrderChange}
      />
    </div>,
  );
  return { onChange, onOrderChange, user };
}

function pickerRow(label: string): HTMLElement {
  const row = screen.getByText(label, { selector: 'label span' }).closest('label');
  if (row === null) throw new Error(`no picker row for ${label}`);
  return row;
}

describe('ColumnsPicker', () => {
  it('counts the visible columns, leaving out hidden and auto-hidden ones', () => {
    renderPicker({ hidden: ['region'], autoHidden: new Set(['service']) });
    expect(screen.getByRole('button', { name: /Columns/ }).textContent).toBe('Columns2/4');
  });

  it('marks tag columns and columns pinned by a filter', async () => {
    const { user } = renderPicker({ autoHidden: new Set(['service']) });
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    expect(within(pickerRow('Team')).getByText('tag')).toBeDefined();
    expect(within(pickerRow('Service')).getByText('filtered')).toBeDefined();
    // A filter-pinned column is not also labelled a tag, and plain columns get neither.
    expect(within(pickerRow('Service')).queryByText('tag')).toBeNull();
    expect(within(pickerRow('Region')).queryByText(/^(tag|filtered)$/)).toBeNull();
  });

  it('hides a shown column and shows a hidden one', async () => {
    const { user, onChange } = renderPicker({ hidden: ['region'] });
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    const service = within(pickerRow('Service')).getByRole('checkbox');
    const region = within(pickerRow('Region')).getByRole('checkbox');
    expect(service).toHaveProperty('checked', true);
    expect(region).toHaveProperty('checked', false);

    await user.click(service);
    expect(onChange).toHaveBeenLastCalledWith(['region', 'service']);
    await user.click(region);
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('offers Show all only when something is hidden, Hide all only when something is shown, and Reset order', async () => {
    const { user, onChange, onOrderChange } = renderPicker({ hidden: ['region'] });
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    await user.click(screen.getByRole('button', { name: 'Show all' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    await user.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(onChange).toHaveBeenLastCalledWith(['service', 'region', 'tag_team', 'cost']);
    await user.click(screen.getByRole('button', { name: 'Reset order' }));
    expect(onOrderChange).toHaveBeenLastCalledWith([]);
    cleanup();

    const none = renderPicker();
    await none.user.click(screen.getByRole('button', { name: /Columns/ }));
    expect(screen.getByRole('button', { name: 'Show all' })).toHaveProperty('disabled', true);
    cleanup();

    const all = renderPicker({ hidden: COLUMNS.map(c => c.id) });
    await all.user.click(screen.getByRole('button', { name: /Columns/ }));
    expect(screen.getByRole('button', { name: 'Hide all' })).toHaveProperty('disabled', true);
  });

  it('closes on a click outside or Escape, but not on a click inside or another key', async () => {
    const { user } = renderPicker();
    const trigger = screen.getByRole('button', { name: /Columns/ });
    await user.click(trigger);
    await user.click(screen.getByText('Drag to reorder', { selector: 'span.text-text-muted' }));
    expect(screen.getByRole('button', { name: 'Reset order' })).toBeDefined();
    await user.keyboard('a');
    expect(screen.getByRole('button', { name: 'Reset order' })).toBeDefined();

    await user.click(screen.getByText('outside the picker'));
    expect(screen.queryByRole('button', { name: 'Reset order' })).toBeNull();

    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('button', { name: 'Reset order' })).toBeNull();

    // The trigger toggles it shut as well.
    await user.click(trigger);
    await user.click(trigger);
    expect(screen.queryByRole('button', { name: 'Reset order' })).toBeNull();
  });

  it('reorders a column by dragging it onto another', async () => {
    const { user, onOrderChange } = renderPicker();
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };
    const cost = pickerRow('Cost');
    const service = pickerRow('Service');

    fireEvent.dragStart(cost, { dataTransfer: transfer });
    expect(transfer.effectAllowed).toBe('move');
    expect(transfer.setData).toHaveBeenCalledWith('text/plain', 'cost');
    expect(pickerRow('Cost').className).toContain('opacity-40');

    fireEvent.dragOver(service, { dataTransfer: transfer });
    expect(transfer.dropEffect).toBe('move');
    expect(pickerRow('Service').className).toContain('border-t-accent');
    // Hovering on over the same target changes nothing.
    fireEvent.dragOver(service, { dataTransfer: transfer });
    // Leaving a row the pointer is not over is ignored...
    fireEvent.dragLeave(pickerRow('Region'));
    expect(pickerRow('Service').className).toContain('border-t-accent');
    // ...leaving the target row clears the marker.
    fireEvent.dragLeave(service);
    expect(pickerRow('Service').className).not.toContain('border-t-accent');

    fireEvent.dragOver(service, { dataTransfer: transfer });
    fireEvent.drop(service, { dataTransfer: transfer });
    expect(onOrderChange).toHaveBeenLastCalledWith(['cost', 'service', 'region', 'tag_team']);
    expect(pickerRow('Cost').className).not.toContain('opacity-40');
    expect(pickerRow('Service').className).not.toContain('border-t-accent');
  });

  it('ignores a drop on the dragged column itself, a drop with no drag, and a cancelled drag', async () => {
    const { user, onOrderChange } = renderPicker();
    await user.click(screen.getByRole('button', { name: /Columns/ }));
    const transfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() };

    fireEvent.drop(pickerRow('Region'), { dataTransfer: transfer });
    fireEvent.dragStart(pickerRow('Region'), { dataTransfer: transfer });
    fireEvent.drop(pickerRow('Region'), { dataTransfer: transfer });
    expect(onOrderChange).not.toHaveBeenCalled();

    fireEvent.dragStart(pickerRow('Team'), { dataTransfer: transfer });
    fireEvent.dragOver(pickerRow('Service'), { dataTransfer: transfer });
    fireEvent.dragEnd(pickerRow('Team'));
    expect(pickerRow('Team').className).not.toContain('opacity-40');
    expect(pickerRow('Service').className).not.toContain('border-t-accent');
    expect(onOrderChange).not.toHaveBeenCalled();
  });
});

describe('DataTable — states and rows', () => {
  it('shows the error, then the loader, then the empty message, in that precedence', () => {
    const view = render(<DataTable data={ROWS} columns={COLUMNS} error="Query failed: out of memory" loading />);
    expect(screen.getByText('Query failed: out of memory')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();

    view.rerender(<DataTable data={ROWS} columns={COLUMNS} error={null} loading />);
    expect(screen.getByRole('status').textContent).toContain('Loading');

    view.rerender(<DataTable data={[]} columns={COLUMNS} emptyMessage="Nothing in this window." />);
    expect(screen.getByText('Nothing in this window.')).toBeDefined();
    expect(screen.getByText('No rows')).toBeDefined();
  });

  it('says every column is hidden instead of drawing an empty table', () => {
    render(<DataTable data={ROWS} columns={[]} />);
    expect(screen.getByText(/All columns are hidden/)).toBeDefined();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('counts the shown rows against the total when only a sample is loaded', () => {
    render(<DataTable data={ROWS} columns={COLUMNS} totalRows={1500} />);
    const header = screen.getByText(/^Showing/);
    expect(header.textContent).toBe(`Showing 2 of ${(1500).toLocaleString()} rows`);
  });

  it('hosts the column picker when it is given the columns and both handlers', async () => {
    const onHidden = vi.fn<(next: readonly string[]) => void>();
    const user = userEvent.setup();
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        allColumns={COLUMNS}
        onHiddenColumnsChange={onHidden}
        onColumnOrderChange={vi.fn()}
        headerRight={<span>extra header</span>}
      />,
    );
    expect(screen.getByText('extra header')).toBeDefined();
    expect(screen.getByText('Click a cell to add that value to filters.')).toBeDefined();
    const picker = screen.getByRole('button', { name: /Columns/ });
    expect(picker.textContent).toBe('Columns4/4');
    await user.click(picker);
    await user.click(within(pickerRow('Cost')).getByRole('checkbox'));
    expect(onHidden).toHaveBeenLastCalledWith(['cost']);
  });

  it('expands a row on click, Enter or Space, and only then', async () => {
    const user = userEvent.setup();
    render(
      <DataTable
        data={ROWS}
        columns={COLUMNS}
        renderExpandedRow={(row) => <p>details for {row.service}</p>}
      />,
    );
    const table = screen.getByRole('table');
    const firstRow = within(table).getAllByRole('row')[1];
    if (firstRow === undefined) throw new Error('row missing');
    expect(firstRow.getAttribute('tabindex')).toBe('0');

    await user.click(within(firstRow).getByText('Amazon EC2'));
    expect(screen.getByText('details for Amazon EC2')).toBeDefined();
    await user.click(within(firstRow).getByText('Amazon EC2'));
    expect(screen.queryByText('details for Amazon EC2')).toBeNull();

    fireEvent.keyDown(firstRow, { key: 'Enter' });
    expect(screen.getByText('details for Amazon EC2')).toBeDefined();
    fireEvent.keyDown(firstRow, { key: ' ' });
    expect(screen.queryByText('details for Amazon EC2')).toBeNull();
    fireEvent.keyDown(firstRow, { key: 'ArrowDown' });
    expect(screen.queryByText('details for Amazon EC2')).toBeNull();
  });

  it('offers a filter click only on a clickable cell that has a value', async () => {
    const onCellClick = vi.fn();
    const clickable: readonly TableColumn<Row>[] = [
      { id: 'team', header: 'Team', dimId: 'tag_team', clickable: true, accessorFn: r => r.team },
      { id: 'resource', header: 'Resource', dimId: 'resource_id', truncate: true, accessorFn: r => `arn:aws:${r.service}` },
      { id: 'cost', header: 'Cost', dimId: null, align: 'right', mono: true, sortable: false, accessorFn: r => r.cost },
    ];
    const user = userEvent.setup();
    render(<DataTable data={ROWS} columns={clickable} onCellClick={onCellClick} />);

    await user.click(screen.getByRole('button', { name: 'platform' }));
    expect(onCellClick).toHaveBeenCalledWith(ROWS[0], 'team', 'platform');
    // The S3 row has no team: plain cell, nothing to add to a filter.
    const rows = within(screen.getByRole('table')).getAllByRole('row');
    const s3 = rows[2];
    if (s3 === undefined) throw new Error('row missing');
    expect(within(s3).queryAllByRole('button')).toHaveLength(0);

    // Truncated cells carry their full text as a tooltip; right-aligned mono cells line up.
    const resource = screen.getByText('arn:aws:Amazon EC2');
    expect(resource.getAttribute('title')).toBe('arn:aws:Amazon EC2');
    const cost = screen.getByText('120');
    expect(cost.className).toContain('text-right');
    expect(cost.className).toContain('font-mono');
    // A non-sortable right-aligned header is a plain label.
    const costHeader = screen.getByText('Cost');
    expect(costHeader.tagName).toBe('SPAN');
    expect(costHeader.className).toContain('justify-end');
  });

  it('pads the rows scrolled out of view once the virtualizer has measured', async () => {
    const many: Row[] = Array.from({ length: 300 }, (_, i) => ({ service: `svc-${String(i)}`, region: 'eu-west-1', team: 't', cost: i }));
    render(<DataTable data={many} columns={COLUMNS} height={400} rowHeight={32} overscan={2} />);
    // Let the mock ResizeObserver report a size.
    await act(async () => { await new Promise(resolve => { setTimeout(resolve, 20); }); });
    const table = screen.getByRole('table');
    const scroller = table.parentElement;
    if (scroller === null) throw new Error('scroller missing');
    expect(screen.queryByText('svc-299')).toBeNull();

    await act(async () => {
      scroller.scrollTop = 3200;
      fireEvent.scroll(scroller);
      await new Promise(resolve => { setTimeout(resolve, 20); });
    });
    expect(screen.queryByText('svc-0')).toBeNull();
    const spacer = table.querySelector('tbody > tr:first-child > td');
    if (!(spacer instanceof HTMLElement)) throw new Error('top spacer missing');
    expect(Number.parseFloat(spacer.style.height)).toBeGreaterThan(0);
  });
});
