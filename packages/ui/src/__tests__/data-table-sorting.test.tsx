import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { SortingState } from '@tanstack/react-table';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';

interface R { readonly name: string; readonly cost: number; readonly sku: string | undefined }

const COLS: readonly TableColumn<R>[] = [
  { id: 'name', header: 'Name', accessorFn: r => r.name },
  { id: 'cost', header: 'Cost', accessorFn: r => r.cost },
  { id: 'sku', header: 'Sku', accessorFn: r => r.sku },
  { id: 'fixed', header: 'Fixed', accessorFn: r => r.name, sortable: false },
];

const DATA: readonly R[] = [
  { name: 'beta', cost: 5, sku: 'item10' },
  { name: 'Alpha', cost: 20, sku: undefined },
  { name: 'gamma', cost: 1, sku: 'item9' },
];

function names(): string[] {
  const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
  return rows.map(r => r.querySelector('td')?.textContent ?? '');
}

function Harness({ initial, onChange }: Readonly<{ initial: SortingState; onChange: (s: SortingState) => void }>) {
  const [sorting, setSorting] = useState<SortingState>(initial);
  return (
    <DataTable<R>
      data={DATA}
      columns={COLS}
      sorting={sorting}
      onSortingChange={(s) => { onChange(s); setSorting(s); }}
    />
  );
}

// Pins the sort behaviour of the TanStack Table v9 feature set in
// table-types.ts. String columns pick their sort function from the first rows:
// case-insensitive `text`, or natural-order `alphanumeric` when values hold
// digits. v8 sampled rows from the 11th on, so tables of 10 rows or fewer
// always fell back to case-sensitive `basic` ('item10' before 'item9').
describe('DataTable sorting', () => {
  it('applies controlled initial sorting client-side', () => {
    render(<Harness initial={[{ id: 'cost', desc: true }]} onChange={vi.fn()} />);
    expect(names()).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('string column: asc -> desc -> removed (case-insensitive text sort)', async () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    const user = userEvent.setup();
    expect(names()).toEqual(['beta', 'Alpha', 'gamma']);
    await user.click(screen.getByRole('button', { name: /^Name/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'name', desc: false }]);
    expect(names()).toEqual(['Alpha', 'beta', 'gamma']);
    await user.click(screen.getByRole('button', { name: /^Name/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'name', desc: true }]);
    expect(names()).toEqual(['gamma', 'beta', 'Alpha']);
    await user.click(screen.getByRole('button', { name: /^Name/ }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(names()).toEqual(['beta', 'Alpha', 'gamma']);
  });

  it('numeric column starts descending', async () => {
    const onChange = vi.fn();
    render(<Harness initial={[]} onChange={onChange} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /^Cost/ }));
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'cost', desc: true }]);
    expect(names()).toEqual(['Alpha', 'beta', 'gamma']);
  });

  it('alphanumeric auto-sort orders item9 before item10; undefined last', () => {
    render(<Harness initial={[{ id: 'sku', desc: false }]} onChange={vi.fn()} />);
    expect(names()).toEqual(['gamma', 'beta', 'Alpha']);
  });

  it('shift-click adds a multi-sort entry', async () => {
    const onChange = vi.fn();
    render(<Harness initial={[{ id: 'name', desc: false }]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.keyboard('{Shift>}');
    await user.click(screen.getByRole('button', { name: /^Cost/ }));
    await user.keyboard('{/Shift}');
    expect(onChange).toHaveBeenLastCalledWith([{ id: 'name', desc: false }, { id: 'cost', desc: true }]);
  });

  it('sortable: false renders a non-button header', () => {
    render(<Harness initial={[]} onChange={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Fixed/ })).toBeNull();
  });

  it('manual mode (no onSortingChange) keeps input order even with sorting state', () => {
    render(<DataTable<R> data={DATA} columns={COLS} sorting={[{ id: 'cost', desc: true }]} />);
    expect(names()).toEqual(['beta', 'Alpha', 'gamma']);
  });
});
