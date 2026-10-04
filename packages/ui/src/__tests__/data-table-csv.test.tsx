import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SortingState } from '@tanstack/react-table';
import { DataTable } from '../components/data-table.js';
import type { TableColumn } from '../lib/table-types.js';

interface R { readonly name: string; readonly cost: number }

const NAME: TableColumn<R> = { id: 'name', header: 'Name', accessorFn: r => r.name };
const COST: TableColumn<R> = { id: 'cost', header: 'Cost', accessorFn: r => r.cost, align: 'right' };

const DATA: readonly R[] = [
  { name: 'beta, inc', cost: 5 },
  { name: '=HYPERLINK("x")', cost: 20 },
  { name: 'gamma', cost: 1 },
];

function Harness({ columns }: Readonly<{ columns: readonly TableColumn<R>[] }>) {
  const [sorting, setSorting] = useState<SortingState>([{ id: 'cost', desc: true }]);
  return <DataTable<R> data={DATA} columns={columns} sorting={sorting} onSortingChange={setSorting} csvFilename="costs" />;
}

// jsdom has no object URLs: capture the exported Blob instead, and keep the
// download link's click from navigating.
let exported: Blob | undefined;
const urlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');

beforeEach(() => {
  exported = undefined;
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob): string => {
      exported = blob;
      return 'blob:csv';
    },
  });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: (): void => undefined });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});

function restore(key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(URL, key);
  else Object.defineProperty(URL, key, descriptor);
}

afterEach(() => {
  restore('createObjectURL', urlDescriptor);
  restore('revokeObjectURL', revokeDescriptor);
  vi.restoreAllMocks();
});

async function exportCsv(): Promise<string[]> {
  await userEvent.setup().click(screen.getByRole('button', { name: /CSV/ }));
  if (exported === undefined) throw new Error('nothing was exported');
  return (await exported.text()).split('\n');
}

describe('DataTable CSV export', () => {
  it('exports the rows in the order shown, escaping formula and comma cells', async () => {
    render(<Harness columns={[NAME, COST]} />);
    expect(await exportCsv()).toEqual([
      'Name,Cost',
      `"'=HYPERLINK(""x"")",20`,
      '"beta, inc",5',
      'gamma,1',
    ]);
  });

  it('exports only the columns the table was given', async () => {
    // The cost sort names a column that isn't there, so it is ignored and the
    // rows keep their input order, on screen as in the file.
    render(<Harness columns={[NAME]} />);
    expect(await exportCsv()).toEqual(['Name', '"beta, inc"', `"'=HYPERLINK(""x"")"`, 'gamma']);
  });
});
