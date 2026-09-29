import { render, screen } from '@testing-library/react';
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
