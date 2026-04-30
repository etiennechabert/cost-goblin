import type { ColumnDef, CellContext, RowData } from '@tanstack/react-table';

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    align?: 'left' | 'right' | undefined;
    mono?: boolean | undefined;
    truncate?: boolean | undefined;
    dimId?: string | null | undefined;
    clickable?: boolean | undefined;
  }
}

export interface TableColumn<TData> {
  readonly id: string;
  readonly header: string;
  readonly accessorFn?: ((row: TData) => unknown) | undefined;
  readonly cell?: ((value: unknown, row: TData) => React.ReactNode) | undefined;
  readonly align?: 'left' | 'right' | undefined;
  readonly mono?: boolean | undefined;
  readonly truncate?: boolean | undefined;
  readonly dimId?: string | null | undefined;
  readonly clickable?: boolean | undefined;
  readonly sortable?: boolean | undefined;
  readonly hideable?: boolean | undefined;
  readonly pinnable?: boolean | undefined;
}

export function toColumnDefs<TData>(columns: readonly TableColumn<TData>[]): ColumnDef<TData>[] {
  return columns.map((col): ColumnDef<TData> => {
    const base = {
      id: col.id,
      header: col.header,
      meta: {
        align: col.align,
        mono: col.mono,
        truncate: col.truncate,
        dimId: col.dimId,
        clickable: col.clickable,
      },
      enableSorting: col.sortable !== false,
      enableHiding: col.hideable !== false,
      enablePinning: col.pinnable === true,
    };

    if (col.accessorFn !== undefined) {
      const fn = col.accessorFn;
      if (col.cell !== undefined) {
        const cellRenderer = col.cell;
        return {
          ...base,
          accessorFn: fn,
          cell: (info: CellContext<TData, unknown>) => cellRenderer(info.getValue(), info.row.original),
        };
      }
      return { ...base, accessorFn: fn };
    }

    return base;
  });
}
