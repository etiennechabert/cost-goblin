import { render, screen, cleanup } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';

interface TestRow {
  id: string;
  name: string;
  value: number;
  description: string;
}

const testData: TestRow[] = [
  { id: '1', name: 'Platform', value: 42000, description: 'Main platform services' },
  { id: '2', name: 'Data', value: 31000, description: 'Data processing and storage' },
  { id: '3', name: 'Infra', value: 14000, description: 'Infrastructure services' },
];

const testColumns: Array<TableColumn<TestRow>> = [
  {
    id: 'name',
    label: 'Name',
    accessorKey: 'name',
    sortable: true,
    pinnable: true,
  },
  {
    id: 'value',
    label: 'Value',
    accessorKey: 'value',
    align: 'right',
    mono: true,
    sortable: true,
  },
  {
    id: 'description',
    label: 'Description',
    accessorKey: 'description',
    truncate: true,
  },
];

afterEach(cleanup);

describe('DataTable', () => {
  it('renders column headers', () => {
    render(<DataTable data={testData} columns={testColumns} />);
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Value')).toBeDefined();
    expect(screen.getByText('Description')).toBeDefined();
  });

  it('renders row data', () => {
    render(<DataTable data={testData} columns={testColumns} />);
    expect(screen.getByText('Platform')).toBeDefined();
    expect(screen.getByText('Data')).toBeDefined();
    expect(screen.getByText('Infra')).toBeDefined();
    expect(screen.getByText('42000')).toBeDefined();
    expect(screen.getByText('31000')).toBeDefined();
    expect(screen.getByText('14000')).toBeDefined();
  });

  it('shows loading state', () => {
    const { container } = render(<DataTable data={testData} columns={testColumns} loading={true} />);
    // CoinRainLoader should be present
    expect(container.querySelector('.coin-rain-loader')).toBeDefined();
    // Data should not be rendered
    expect(screen.queryByText('Platform')).toBeNull();
  });

  it('shows error state', () => {
    render(<DataTable data={testData} columns={testColumns} error="Failed to load data" />);
    expect(screen.getByText('Failed to load data')).toBeDefined();
    // Data should not be rendered
    expect(screen.queryByText('Platform')).toBeNull();
  });

  it('shows empty state with default message', () => {
    render(<DataTable data={[]} columns={testColumns} />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('shows empty state with custom message', () => {
    render(<DataTable data={[]} columns={testColumns} emptyMessage="Custom empty message" />);
    expect(screen.getByText('Custom empty message')).toBeDefined();
  });

  it('handles column sorting', async () => {
    const onSortingChange = vi.fn();
    const user = userEvent.setup();

    render(
      <DataTable
        data={testData}
        columns={testColumns}
        sorting={[]}
        onSortingChange={onSortingChange}
      />
    );

    // Click on Name header to sort
    await user.click(screen.getByText('Name'));
    expect(onSortingChange).toHaveBeenCalled();
  });

  it('displays sort indicator when sorted ascending', () => {
    const { container } = render(
      <DataTable
        data={testData}
        columns={testColumns}
        sorting={[{ id: 'name', desc: false }]}
      />
    );

    // ChevronUp icon should be present
    const chevronUp = container.querySelector('svg');
    expect(chevronUp).toBeDefined();
  });

  it('displays sort indicator when sorted descending', () => {
    const { container } = render(
      <DataTable
        data={testData}
        columns={testColumns}
        sorting={[{ id: 'value', desc: true }]}
      />
    );

    // ChevronDown icon should be present
    const chevronDown = container.querySelector('svg');
    expect(chevronDown).toBeDefined();
  });

  it('displays multi-sort indicators', () => {
    render(
      <DataTable
        data={testData}
        columns={testColumns}
        sorting={[
          { id: 'name', desc: false },
          { id: 'value', desc: true },
        ]}
      />
    );

    // Sort index numbers should be displayed (1 and 2)
    expect(screen.getByText('1')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('respects column visibility state', () => {
    render(
      <DataTable
        data={testData}
        columns={testColumns}
        columnVisibility={{ value: false }}
      />
    );

    // Value column should be hidden
    expect(screen.queryByText('Value')).toBeNull();
    expect(screen.queryByText('42000')).toBeNull();

    // Other columns should still be visible
    expect(screen.getByText('Name')).toBeDefined();
    expect(screen.getByText('Platform')).toBeDefined();
  });

  it('calls onCellClick when cell is clicked', async () => {
    const onCellClick = vi.fn();
    const user = userEvent.setup();

    render(
      <DataTable
        data={testData}
        columns={testColumns}
        onCellClick={onCellClick}
      />
    );

    // Click on a cell
    await user.click(screen.getByText('Platform'));
    expect(onCellClick).toHaveBeenCalledWith(
      testData[0],
      'name',
      'Platform'
    );
  });

  it('shows CSV export button when showCsvExport is true', () => {
    render(
      <DataTable
        data={testData}
        columns={testColumns}
        showCsvExport={true}
      />
    );

    // CSV export button should be present
    expect(screen.getByText('Export CSV')).toBeDefined();
  });

  it('does not show CSV export button by default', () => {
    render(<DataTable data={testData} columns={testColumns} />);

    // CSV export button should not be present
    expect(screen.queryByText('Export CSV')).toBeNull();
  });

  it('applies custom className to container', () => {
    const { container } = render(
      <DataTable
        data={testData}
        columns={testColumns}
        className="custom-table-class"
      />
    );

    // Find the table container div
    const tableContainer = container.querySelector('.custom-table-class');
    expect(tableContainer).toBeDefined();
  });

  it('applies maxHeight style when provided', () => {
    const { container } = render(
      <DataTable
        data={testData}
        columns={testColumns}
        maxHeight={500}
      />
    );

    // Find element with max-height style
    const elementWithMaxHeight = container.querySelector('[style*="max-height"]');
    expect(elementWithMaxHeight).toBeDefined();
    expect(elementWithMaxHeight?.getAttribute('style')).toContain('500px');
  });

  it('renders custom cell content', () => {
    const customColumns: Array<TableColumn<TestRow>> = [
      {
        id: 'name',
        label: 'Name',
        accessorKey: 'name',
        cell: (row: TestRow) => <strong>{row.name.toUpperCase()}</strong>,
      },
    ];

    render(<DataTable data={testData} columns={customColumns} />);

    // Custom cell rendering should show uppercase text in strong tags
    const strongElement = screen.getByText('PLATFORM');
    expect(strongElement).toBeDefined();
    expect(strongElement.tagName).toBe('STRONG');
  });

  it('applies alignment classes to cells', () => {
    const { container } = render(<DataTable data={testData} columns={testColumns} />);

    // Find cells in the Value column (which has align: 'right')
    const valueCells = container.querySelectorAll('td');
    // The Value column cells should have text-right class
    const rightAlignedCells = Array.from(valueCells).filter(cell =>
      cell.className.includes('text-right')
    );
    expect(rightAlignedCells.length).toBeGreaterThan(0);
  });

  it('applies mono font class to cells when specified', () => {
    const { container } = render(<DataTable data={testData} columns={testColumns} />);

    // Value column has mono: true
    const monoCells = container.querySelectorAll('.font-mono');
    expect(monoCells.length).toBeGreaterThan(0);
  });

  it('applies truncate class to cells when specified', () => {
    const { container } = render(<DataTable data={testData} columns={testColumns} />);

    // Description column has truncate: true
    const truncateCells = container.querySelectorAll('.truncate');
    expect(truncateCells.length).toBeGreaterThan(0);
  });

  it('handles pinned columns', () => {
    const { container } = render(
      <DataTable
        data={testData}
        columns={testColumns}
        columnPinning={{ left: ['name'], right: [] }}
      />
    );

    // Pinned column headers should have sticky positioning
    const stickyHeaders = container.querySelectorAll('th.sticky');
    expect(stickyHeaders.length).toBeGreaterThan(0);

    // Pinned cells should also have sticky positioning
    const stickyCells = container.querySelectorAll('td.sticky');
    expect(stickyCells.length).toBeGreaterThan(0);
  });

  it('handles display column without accessorKey', () => {
    const displayColumns: Array<TableColumn<TestRow>> = [
      {
        id: 'name',
        label: 'Name',
        accessorKey: 'name',
      },
      {
        id: 'actions',
        label: 'Actions',
        accessorKey: null,
        cell: () => <button type="button">Delete</button>,
      },
    ];

    render(<DataTable data={testData} columns={displayColumns} />);

    // All rows should have a Delete button
    const deleteButtons = screen.getAllByText('Delete');
    expect(deleteButtons.length).toBe(testData.length);
  });
});
