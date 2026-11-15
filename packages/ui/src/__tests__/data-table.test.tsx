import { fireEvent, render, screen } from '@testing-library/react';
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

// A row that expands is a focusable <tr>, not a button: the browser's own
// answer to Space on it is to scroll the page. fireEvent returns false when
// the handler prevented that default.
describe('DataTable — an expandable row on the keyboard', () => {
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

  it('toggles on Space without scrolling the page, and leaves the other keys their default', () => {
    const { row } = renderTable(true);

    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false);
    expect(screen.getByText('detail of eu-central-1')).toBeDefined();
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false);
    expect(screen.queryByText('detail of eu-central-1')).toBeNull();

    expect(fireEvent.keyDown(row, { key: 'Enter' })).toBe(true);
    expect(screen.getByText('detail of eu-central-1')).toBeDefined();
    expect(fireEvent.keyDown(row, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(row, { key: 'Tab' })).toBe(true);
    expect(screen.getByText('detail of eu-central-1')).toBeDefined();
  });

  // Space pressed on a button inside the row reaches the row's handler too.
  // Preventing its default there would cancel the click the button makes of it.
  it('prevents the default of Space pressed on the row, not on a button inside it', () => {
    const { row, cell } = renderTable(true);

    expect(fireEvent.keyDown(cell, { key: ' ' })).toBe(true);
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(false);
  });

  // The cell's click filters and stays out of the row. The key that makes
  // that click used to reach the row all the same, and expanded it.
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

  it('leaves Space alone on a row that cannot expand', () => {
    const { row } = renderTable(false);

    expect(row.tabIndex).toBe(-1);
    expect(fireEvent.keyDown(row, { key: ' ' })).toBe(true);
  });
});
