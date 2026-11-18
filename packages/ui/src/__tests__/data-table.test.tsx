import { fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';

interface Row {
  readonly region: string;
}

const COLUMNS: readonly TableColumn<Row>[] = [
  { id: 'region', header: 'Region', dimId: 'region', clickable: true, accessorFn: r => r.region },
];

const DATA: readonly Row[] = [{ region: 'eu-central-1' }, { region: 'us-east-1' }];

describe('DataTable', () => {
  // The virtualizer yields no items until the scroll element's first
  // ResizeObserver measurement (async). The rows rendered before it must be
  // the rows rendered after it — a remount at that point detached the cell a
  // click had just been aimed at, silently dropping the click.
  it('keeps the first-rendered rows mounted once the virtualizer measures', async () => {
    const onCellClick = vi.fn();
    render(<DataTable data={DATA} columns={COLUMNS} onCellClick={onCellClick} />);
    const cell = screen.getByRole('button', { name: 'eu-central-1' });

    // Let the mock ResizeObserver report and React commit the measured render.
    await new Promise(resolve => { setTimeout(resolve, 50); });
    expect(cell.isConnected).toBe(true);

    await userEvent.setup().click(cell);
    expect(onCellClick).toHaveBeenCalledWith(DATA[0], 'region', 'eu-central-1');
  });
});

// A row that expands carries a disclosure button in a leading column of its
// own. Its state (aria-expanded) and the keyboard go through that button: on
// the <tr> itself aria-expanded means something only in a tree grid, so the
// row takes clicks and nothing else.
describe('DataTable — an expandable row', () => {
  function renderTable(expandable: boolean) {
    const onCellClick = vi.fn();
    render(
      <DataTable
        data={DATA}
        columns={COLUMNS}
        onCellClick={onCellClick}
        renderExpandedRow={expandable ? (r) => <span>detail of {r.region}</span> : undefined}
      />,
    );
    const cell = screen.getByRole('button', { name: 'eu-central-1' });
    const row = cell.closest('tr');
    if (row === null) throw new Error('the cell has no row');
    return { row, cell, onCellClick };
  }

  const toggleOf = (row: HTMLElement): HTMLElement => within(row).getByRole('button', { name: 'Row details' });
  const detailRow = (): HTMLTableRowElement | null => screen.getByText('detail of eu-central-1').closest('tr');

  it('gives a row that cannot expand no button, no column for one and no tab stop', () => {
    const { row } = renderTable(false);

    expect(within(row).queryByRole('button', { name: 'Row details' })).toBeNull();
    expect(screen.getAllByRole('columnheader')).toHaveLength(1);
    expect(row.hasAttribute('tabindex')).toBe(false);
  });

  it('gives a row that expands its button in a leading column, under a header of its own', () => {
    const { row } = renderTable(true);

    const headers = screen.getAllByRole('columnheader');
    expect(headers).toHaveLength(2);
    expect(headers[0]?.textContent).toBe('Details');
    expect(row.cells[0]?.contains(toggleOf(row))).toBe(true);
  });

  // One click toggles once: the row's own click toggles too, and a click
  // that reached it from the button would put the row back as it was.
  it('says on the button whether the row is expanded, and which row holds the details', async () => {
    const user = userEvent.setup();
    const { row } = renderTable(true);
    const toggle = toggleOf(row);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);

    await user.click(toggle);
    const detail = detailRow();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(detail?.id).toBeTruthy();
    expect(toggle.getAttribute('aria-controls')).toBe(detail?.id);
    // The details run under the button's column too.
    expect(detail?.cells[0]?.colSpan).toBe(2);

    await user.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.hasAttribute('aria-controls')).toBe(false);
    expect(screen.queryByText('detail of eu-central-1')).toBeNull();
  });

  it('toggles on Enter and on Space pressed on the button', async () => {
    const user = userEvent.setup();
    const { row } = renderTable(true);

    toggleOf(row).focus();
    await user.keyboard('{Enter}');
    expect(detailRow()).not.toBeNull();
    await user.keyboard(' ');
    expect(screen.queryByText('detail of eu-central-1')).toBeNull();
  });

  // The pointer keeps the whole row as its target. The keyboard has the
  // button: the row is no tab stop and answers no key.
  it('toggles on a click anywhere else on the row, which takes no focus and no key', async () => {
    const user = userEvent.setup();
    const { row, cell } = renderTable(true);
    const td = cell.closest('td');
    if (td === null) throw new Error('the button has no cell');

    await user.click(td);
    expect(detailRow()).not.toBeNull();
    expect(toggleOf(row).getAttribute('aria-expanded')).toBe('true');

    expect(row.hasAttribute('tabindex')).toBe(false);
    // One key at a time: two toggles in a row would cancel each other out.
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(detailRow()).not.toBeNull();
    fireEvent.keyDown(row, { key: ' ' });
    expect(detailRow()).not.toBeNull();
  });

  // The cell's click filters and stays out of the row, however it was made.
  it('filters without toggling the row on Enter or Space pressed on a button inside it', async () => {
    const user = userEvent.setup();
    const { cell, onCellClick } = renderTable(true);

    cell.focus();
    await user.keyboard('{Enter}');
    expect(screen.queryByText('detail of eu-central-1')).toBeNull();
    await user.keyboard(' ');
    expect(screen.queryByText('detail of eu-central-1')).toBeNull();
    expect(onCellClick).toHaveBeenCalledTimes(2);
  });
});
