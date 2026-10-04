import {
  createSortedRowModel,
  metaHelper,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
} from '@tanstack/react-table';
import type { CellContext, ColumnDef, RowData } from '@tanstack/react-table';

/** Per-column metadata read by DataTable's header/cell renderers. Declared
 *  through the per-table `columnMeta` slot below rather than a global
 *  `declare module` merge on `ColumnMeta`. */
export interface DataTableColumnMeta {
  readonly align?: 'left' | 'right' | undefined;
  readonly mono?: boolean | undefined;
  readonly truncate?: boolean | undefined;
  readonly dimId?: string | null | undefined;
  readonly clickable?: boolean | undefined;
}

/** The TanStack v9 feature set every DataTable is built with. v9 bundles no
 *  features by default: sorting state/APIs, the client-side sorted row model
 *  and the sort functions `sortFn: 'auto'` may pick are all opt-in. The
 *  registered sortFns are exactly the ones v8's auto-sort chose between
 *  (`basic` is the built-in fallback and needs no registration). */
export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  columnMeta: metaHelper<DataTableColumnMeta>(),
});

export type DataTableFeatures = typeof dataTableFeatures;

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
}

export function toColumnDefs<TData extends RowData>(
  columns: readonly TableColumn<TData>[],
): ColumnDef<DataTableFeatures, TData>[] {
  return columns.map((col): ColumnDef<DataTableFeatures, TData> => {
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
    };

    if (col.accessorFn !== undefined) {
      const fn = col.accessorFn;
      if (col.cell !== undefined) {
        const cellRenderer = col.cell;
        return {
          ...base,
          accessorFn: fn,
          cell: (info: CellContext<DataTableFeatures, TData>) => cellRenderer(info.getValue(), info.row.original),
        };
      }
      return { ...base, accessorFn: fn };
    }

    return base;
  });
}
