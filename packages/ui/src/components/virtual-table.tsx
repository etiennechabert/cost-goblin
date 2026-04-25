import { useRef, useMemo } from 'react';
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { VirtualTableProps } from '../lib/table-types.js';
import { cn } from '../lib/utils.js';
import { CoinRainLoader } from './coin-rain-loader.js';
import { ColumnVisibilityToggle } from './column-visibility-toggle.js';
import { TableCsvExport } from './table-csv-export.js';

/** Headless TanStack Table wrapper with virtual scrolling for 10k+ row datasets.
 *  Uses @tanstack/react-virtual to render only visible rows, enabling smooth
 *  scrolling of large datasets without performance degradation.
 *
 *  Supports column pinning (left side), multi-column sorting, column visibility,
 *  and all the same features as DataTable but optimized for large datasets. */
export function VirtualTable<TData>({
  data,
  columns,
  columnVisibility = {},
  onColumnVisibilityChange,
  columnPinning = { left: [], right: [] },
  onColumnPinningChange,
  sorting = [],
  onSortingChange,
  loading = false,
  error = null,
  emptyMessage = 'No data available',
  rowHeight = 48,
  overscan = 10,
  onCellClick,
  showColumnVisibilityToggle = false,
  showCsvExport = false,
  csvFilename = 'export.csv',
}: Readonly<VirtualTableProps<TData>>): React.JSX.Element {
  const tableContainerRef = useRef<HTMLDivElement>(null);

  // Convert TableColumn<TData> to TanStack Table's ColumnDef format
  const columnDefs = useMemo<Array<ColumnDef<TData>>>(
    () => columns.map(col => {
      const hasAccessorKey = col.accessorKey !== null && col.accessorKey !== undefined;
      const baseDef = {
        id: col.id,
        header: col.label,
        enableSorting: col.sortable ?? hasAccessorKey,
        enablePinning: col.pinnable ?? false,
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
      columnPinning,
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    // Enable multi-column sort
    enableMultiSort: true,
    // Don't remove sorting when toggling visibility
    enableSortingRemoval: true,
    // Enable column pinning
    enableColumnPinning: true,
  };

  // Conditionally add callbacks to satisfy exactOptionalPropertyTypes
  if (onSortingChange !== undefined) {
    Object.assign(tableConfig, { onSortingChange });
  }
  if (onColumnVisibilityChange !== undefined) {
    Object.assign(tableConfig, { onColumnVisibilityChange });
  }
  if (onColumnPinningChange !== undefined) {
    Object.assign(tableConfig, { onColumnPinningChange });
  }

  const table = useReactTable(tableConfig);

  // Virtual scrolling setup - only virtualize if we have data
  const rows = table.getRowModel().rows;
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => tableContainerRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

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

  // Get header groups and virtual items
  const headerGroups = table.getHeaderGroups();
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="space-y-2">
      {(showColumnVisibilityToggle || showCsvExport) && (
        <div className="flex justify-end gap-2">
          {showCsvExport && (
            <TableCsvExport table={table} filename={csvFilename} />
          )}
          {showColumnVisibilityToggle && onColumnVisibilityChange !== undefined && (
            <ColumnVisibilityToggle table={table} />
          )}
        </div>
      )}
      <div
        ref={tableContainerRef}
        className="border border-border rounded-md overflow-auto"
        style={{ height: '600px' }}
      >
      <div style={{ height: `${String(virtualizer.getTotalSize())}px`, width: '100%', position: 'relative' }}>
        <table className="text-[11px] w-full border-collapse">
          {/* Table Header - Sticky */}
          <thead className="sticky top-0 z-10 bg-bg-tertiary/95 backdrop-blur-sm">
            {headerGroups.map(headerGroup => (
              <tr key={headerGroup.id} className="text-left text-text-secondary">
                {headerGroup.headers.map(header => {
                  const meta = header.column.columnDef.meta as
                    | { align?: 'left' | 'right' | 'center'; mono?: boolean }
                    | undefined;
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  const isPinned = header.column.getIsPinned();
                  const sortIndex = header.column.getSortIndex();
                  const isMultiSort = table.getState().sorting.length > 1;

                  return (
                    <th
                      key={header.id}
                      className={cn(
                        'px-3 py-2.5 font-medium border-b border-border/60',
                        meta?.align === 'right' && 'text-right',
                        meta?.align === 'center' && 'text-center',
                        canSort && 'cursor-pointer select-none hover:text-text-primary',
                        isPinned === 'left' && 'sticky left-0 z-20 bg-bg-tertiary/95 backdrop-blur-sm',
                      )}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      style={
                        isPinned === 'left'
                          ? {
                              left: `${String(header.getStart('left'))}px`,
                            }
                          : undefined
                      }
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
                          <span className="text-accent flex items-center gap-0.5">
                            {sortDir === 'asc' ? (
                              <ChevronUp className="h-3 w-3" />
                            ) : (
                              <ChevronDown className="h-3 w-3" />
                            )}
                            {isMultiSort && (
                              <span className="text-[10px] font-semibold">
                                {String(sortIndex + 1)}
                              </span>
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

          {/* Virtual Table Body */}
          <tbody>
            {virtualItems.map(virtualRow => {
              const row = rows[virtualRow.index];
              if (row === undefined) {
                return null;
              }

              return (
                <tr
                  key={row.id}
                  className="border-t border-border/40 hover:bg-bg-tertiary/30 transition-colors"
                  style={{
                    height: `${String(rowHeight)}px`,
                    transform: `translateY(${String(virtualRow.start)}px)`,
                    position: 'absolute',
                    width: '100%',
                  }}
                >
                  {row.getVisibleCells().map(cell => {
                    const meta = cell.column.columnDef.meta as
                      | { align?: 'left' | 'right' | 'center'; mono?: boolean; truncate?: boolean; dimId?: string | null }
                      | undefined;
                    const isClickable = onCellClick !== undefined;
                    const isPinned = cell.column.getIsPinned();

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
                          isPinned === 'left' && 'sticky left-0 z-10 bg-bg-primary',
                        )}
                        onClick={
                          isClickable
                            ? () => {
                                const value = cell.getValue();
                                onCellClick(row.original, cell.column.id, value);
                              }
                            : undefined
                        }
                        title={meta?.truncate === true ? String(cell.getValue()) : undefined}
                        style={
                          isPinned === 'left'
                            ? {
                                left: `${String(cell.column.getStart('left'))}px`,
                              }
                            : undefined
                        }
                      >
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      </div>
    </div>
  );
}
