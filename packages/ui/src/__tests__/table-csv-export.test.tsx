/* eslint-disable @typescript-eslint/no-deprecated, @typescript-eslint/unbound-method */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
} from '@tanstack/react-table';
import { TableCsvExport } from '../components/table-csv-export.js';

interface TestRow {
  readonly id: number;
  readonly name: string;
  readonly cost: number;
}

function TestTableWrapper({
  data,
  columns,
  columnVisibility = {},
  sorting = [],
}: {
  readonly data: readonly TestRow[];
  readonly columns: readonly ColumnDef<TestRow>[];
  readonly columnVisibility?: Record<string, boolean>;
  readonly sorting?: Array<{ id: string; desc: boolean }>;
}) {
  const table = useReactTable({
    data: data as TestRow[],
    columns: columns as ColumnDef<TestRow>[],
    state: { columnVisibility, sorting },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  return <TableCsvExport table={table} filename="test.csv" />;
}

describe('TableCsvExport', () => {
  it('renders export button', () => {
    const columns: readonly ColumnDef<TestRow>[] = [
      { id: 'name', header: 'Name', accessorKey: 'name' },
      { id: 'cost', header: 'Cost', accessorKey: 'cost' },
    ];
    const data: readonly TestRow[] = [
      { id: 1, name: 'Item 1', cost: 100 },
    ];

    render(<TestTableWrapper data={data} columns={columns} />);

    expect(screen.getByRole('button', { name: /Export CSV/i })).toBeDefined();
  });

  it('exports visible columns only (hidden columns excluded)', async () => {
    const user = userEvent.setup();
    const columns: readonly ColumnDef<TestRow>[] = [
      { id: 'id', header: 'ID', accessorKey: 'id' },
      { id: 'name', header: 'Name', accessorKey: 'name' },
      { id: 'cost', header: 'Cost', accessorKey: 'cost' },
    ];
    const data: readonly TestRow[] = [
      { id: 1, name: 'Item 1', cost: 100 },
      { id: 2, name: 'Item 2', cost: 200 },
    ];

    // Hide the 'id' column
    const columnVisibility = { id: false };

    // Mock URL.createObjectURL and link.click()
    const mockUrl = 'blob:mock-url';
    global.URL.createObjectURL = vi.fn(() => mockUrl);
    global.URL.revokeObjectURL = vi.fn();

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement;
    document.createElement = vi.fn((tagName: string) => {
      const element = origCreateElement.call(document, tagName);
      if (tagName === 'a') {
        element.click = clickSpy;
      }
      return element;
    }) as typeof document.createElement;

    render(<TestTableWrapper data={data} columns={columns} columnVisibility={columnVisibility} />);

    const button = screen.getByRole('button', { name: /Export CSV/i });
    await user.click(button);

    // Verify CSV was created with only visible columns (Name, Cost)
    expect(global.URL.createObjectURL).toHaveBeenCalledOnce();
    const blobArg = (global.URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Blob;
    expect(blobArg).toBeInstanceOf(Blob);

    const csvText = await blobArg.text();
    const lines = csvText.split('\n');

    // Header should only have Name and Cost (ID is hidden)
    expect(lines[0]).toBe('Name,Cost');
    expect(lines[1]).toBe('Item 1,100');
    expect(lines[2]).toBe('Item 2,200');

    // Verify download was triggered
    expect(clickSpy).toHaveBeenCalledOnce();

    document.createElement = origCreateElement;
  });

  it('exports rows in current sort order', async () => {
    const user = userEvent.setup();
    const columns: readonly ColumnDef<TestRow>[] = [
      { id: 'name', header: 'Name', accessorKey: 'name' },
      { id: 'cost', header: 'Cost', accessorKey: 'cost' },
    ];
    const data: readonly TestRow[] = [
      { id: 1, name: 'Item A', cost: 300 },
      { id: 2, name: 'Item B', cost: 100 },
      { id: 3, name: 'Item C', cost: 200 },
    ];

    // Sort by cost descending
    const sorting = [{ id: 'cost', desc: true }];

    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement;
    document.createElement = vi.fn((tagName: string) => {
      const element = origCreateElement.call(document, tagName);
      if (tagName === 'a') {
        element.click = clickSpy;
      }
      return element;
    }) as typeof document.createElement;

    render(<TestTableWrapper data={data} columns={columns} sorting={sorting} />);

    const button = screen.getByRole('button', { name: /Export CSV/i });
    await user.click(button);

    const blobArg = (global.URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Blob;
    const csvText = await blobArg.text();
    const lines = csvText.split('\n');

    // Rows should be sorted by cost descending (300, 200, 100)
    expect(lines[0]).toBe('Name,Cost');
    expect(lines[1]).toBe('Item A,300');
    expect(lines[2]).toBe('Item C,200');
    expect(lines[3]).toBe('Item B,100');

    document.createElement = origCreateElement;
  });

  it('escapes CSV special characters correctly', async () => {
    const user = userEvent.setup();
    const columns: readonly ColumnDef<TestRow>[] = [
      { id: 'name', header: 'Name', accessorKey: 'name' },
      { id: 'cost', header: 'Cost', accessorKey: 'cost' },
    ];
    const data: readonly TestRow[] = [
      { id: 1, name: 'Item with, comma', cost: 100 },
      { id: 2, name: 'Item with "quotes"', cost: 200 },
    ];

    global.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = vi.fn();

    const clickSpy = vi.fn();
    const origCreateElement = document.createElement;
    document.createElement = vi.fn((tagName: string) => {
      const element = origCreateElement.call(document, tagName);
      if (tagName === 'a') {
        element.click = clickSpy;
      }
      return element;
    }) as typeof document.createElement;

    render(<TestTableWrapper data={data} columns={columns} />);

    const button = screen.getByRole('button', { name: /Export CSV/i });
    await user.click(button);

    const blobArg = (global.URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Blob;
    const csvText = await blobArg.text();
    const lines = csvText.split('\n');

    // Values with commas or quotes should be wrapped in quotes and escaped
    expect(lines[1]).toBe('"Item with, comma",100');
    expect(lines[2]).toBe('"Item with ""quotes""",200');

    document.createElement = origCreateElement;
  });
});
