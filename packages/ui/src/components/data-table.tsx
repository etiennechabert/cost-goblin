import { useMemo } from 'react';
import {
  type ColumnDef,
  type OnChangeFn,
  type SortingState,
  type VisibilityState,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { TableColumn } from '../lib/table-types.js';
import { cn } from '../lib/utils.js';
import { CoinRainLoader } from './coin-rain-loader.js';

/** Props for the DataTable component — a headless TanStack Table wrapper with
 *  sorting and column visibility. This is the non-virtualized table component
 *  suitable for datasets under ~1000 rows. For larger datasets (10k+ rows),
 *  use VirtualTable instead. */
export interface DataTableProps<TData> {
  /** Row data array. */
  readonly data: readonly TData[];
  /** Column definitions — must include an `id` field for TanStack Table's
   *  internal tracking. See TableColumn<TData> for the full interface. */
  readonly columns: readonly TableColumn<TData>[];
  /** Initial column visibility state. Missing column IDs default to visible.
   *  Controlled by the consuming component. */
  readonly columnVisibility?: VisibilityState | undefined;
  /** Callback fired when the user toggles column visibility via the column
   *  picker dropdown. The consuming component should persist this state. */
  readonly onColumnVisibilityChange?: OnChangeFn<VisibilityState> | undefined;
  /** Initial sort state. Array of { id: columnId, desc: boolean } objects.
   *  Multi-column sort is supported — shift+click a header to add a secondary
   *  sort. Empty array means no sorting. */
  readonly sorting?: SortingState | undefined;
  /** Callback fired when the user clicks a column header to sort. The
   *  consuming component should persist this state if needed. */
  readonly onSortingChange?: OnChangeFn<SortingState> | undefined;
  /** Optional loading indicator. When true, displays a semi-transparent
   *  overlay with a spinner (CoinRainLoader). */
  readonly loading?: boolean | undefined;
  /** Optional error message. When non-null, displays an error banner above
   *  the table. */
  readonly error?: string | null | undefined;
  /** Optional empty state message displayed when data.length === 0 and
   *  loading === false. Defaults to "No data available". */
  readonly emptyMessage?: string | undefined;
  /** Optional callback fired when the user clicks a cell. Receives the row
   *  data, column ID, and cell value. Used by Explorer to add filter chips
   *  when clicking dimension values. */
  readonly onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
  /** Optional className for the table container. */
  readonly className?: string | undefined;
  /** Optional max height for the table container. When set, the table will
   *  scroll vertically. Defaults to undefined (no max height). */
  readonly maxHeight?: number | undefined;
}

/** Headless TanStack Table wrapper with sorting and column visibility.
 *  This component converts TableColumn<TData> definitions to TanStack Table's
 *  ColumnDef format and renders a styled table with sticky headers.
 *
 *  For datasets under ~1000 rows. For larger datasets (10k+), use VirtualTable
 *  which wraps this component with @tanstack/react-virtual. */
export function DataTable<TData>({
  data,
  columns,
  columnVisibility = {},
  onColumnVisibilityChange,
  sorting = [],
  onSortingChange,
  loading = false,
  error = null,
  emptyMessage = 'No data available',
  onCellClick,
  className,
  maxHeight,
}: Readonly<DataTableProps<TData>>): React.JSX.Element {
  // Convert TableColumn<TData> to TanStack Table's ColumnDef format
  const columnDefs = useMemo<Array<ColumnDef<TData>>>(
    () => columns.map(col => {
      const hasAccessorKey = col.accessorKey !== null && col.accessorKey !== undefined;
      const baseDef = {
        id: col.id,
        header: col.label,
        enableSorting: col.sortable ?? hasAccessorKey,
        meta: {
          align: col.align ?? 'left',
          mono: col.mono ?? false,
          truncate: col.truncate ?? false,
          dimId: col.dimId ?? null,
        },
      };

      // When accessorKey is present, create an accessor column
      if (hasAccessorKey) {
        const result: ColumnDef<TData> = {
          ...baseDef,
          accessorKey: col.accessorKey as string,
        };
        if (col.cell !== undefined) {
          result.cell = ({ row }: { row: { original: TData } }) => col.cell?.(row.original);
        }
        return result;
      }

      // Display column without accessorKey - must have a cell renderer
      const result: ColumnDef<TData> = {
        ...baseDef,
        cell: col.cell !== undefined
          ? ({ row }: { row: { original: TData } }) => col.cell?.(row.original)
          : () => null,
      };
      return result;
    }),
    [columns],
  );

  const tableConfig = {
    data: data as TData[],
    columns: columnDefs,
    state: {
      sorting,
      columnVisibility,
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // Enable multi-column sort
    enableMultiSort: true,
    // Don't remove sorting when toggling visibility
    enableSortingRemoval: true,
  };

  // Conditionally add callbacks to satisfy exactOptionalPropertyTypes
  if (onSortingChange !== undefined) {
    Object.assign(tableConfig, { onSortingChange });
  }
  if (onColumnVisibilityChange !== undefined) {
    Object.assign(tableConfig, { onColumnVisibilityChange });
  }

  const table = useReactTable(tableConfig);

  // Error state
  if (error !== null) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-negative/40 bg-negative/5 text-xs text-negative px-3 py-2">
          {error}
        </div>
      </div>
    );
  }

  // Loading state
  if (loading) {
    return <CoinRainLoader height={260} count={7} />;
  }

  // Empty state
  if (data.length === 0) {
    return (
      <div className="text-xs text-text-muted py-4 text-center">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'border border-border rounded-md overflow-auto',
        className,
      )}
      style={maxHeight !== undefined ? { maxHeight: `${String(maxHeight)}px` } : undefined}
    >
      <table className="text-[11px] w-full border-collapse">
        <thead className="sticky top-0 z-10 bg-bg-tertiary/95 backdrop-blur-sm">
          {table.getHeaderGroups().map(headerGroup => (
            <tr key={headerGroup.id} className="text-left text-text-secondary">
              {headerGroup.headers.map(header => {
                const meta = header.column.columnDef.meta as
                  | { align?: 'left' | 'right' | 'center'; mono?: boolean }
                  | undefined;
                const canSort = header.column.getCanSort();
                const sortDir = header.column.getIsSorted();

                return (
                  <th
                    key={header.id}
                    className={cn(
                      'px-3 py-2.5 font-medium border-b border-border/60',
                      meta?.align === 'right' && 'text-right',
                      meta?.align === 'center' && 'text-center',
                      canSort && 'cursor-pointer select-none hover:text-text-primary',
                    )}
                    onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                  >
                    <div
                      className={cn(
                        'flex items-center gap-1.5',
                        meta?.align === 'right' && 'justify-end',
                        meta?.align === 'center' && 'justify-center',
                      )}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && sortDir !== false && (
                        <span className="text-accent">
                          {sortDir === 'asc' ? (
                            <ChevronUp className="h-3 w-3" />
                          ) : (
                            <ChevronDown className="h-3 w-3" />
                          )}
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map(row => (
            <tr
              key={row.id}
              className="border-t border-border/40 hover:bg-bg-tertiary/30 transition-colors"
            >
              {row.getVisibleCells().map(cell => {
                const meta = cell.column.columnDef.meta as
                  | { align?: 'left' | 'right' | 'center'; mono?: boolean; truncate?: boolean; dimId?: string | null }
                  | undefined;
                const isClickable = onCellClick !== undefined && meta?.dimId !== null && meta?.dimId !== undefined;

                return (
                  <td
                    key={cell.id}
                    className={cn(
                      'px-3 py-2.5',
                      meta?.align === 'right' && 'text-right',
                      meta?.align === 'center' && 'text-center',
                      meta?.mono === true && 'font-mono',
                      meta?.truncate === true && 'max-w-xs truncate',
                      isClickable && 'cursor-pointer hover:text-accent',
                    )}
                    onClick={
                      isClickable
                        ? () => {
                            const value = cell.getValue();
                            const dimId = meta?.dimId;
                            if (dimId !== null && dimId !== undefined) {
                              onCellClick?.(row.original, cell.column.id, value);
                            }
                          }
                        : undefined
                    }
                    title={meta?.truncate === true ? String(cell.getValue()) : undefined}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
