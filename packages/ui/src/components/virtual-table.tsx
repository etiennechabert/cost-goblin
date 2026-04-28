import { useMemo, useRef, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import type { SortingState, Row, Cell } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { TableColumn } from '../lib/table-types.js';
import { toColumnDefs } from '../lib/table-types.js';
import { CoinRainLoader } from './coin-rain-loader.js';
import { ColumnsPicker } from './data-table.js';
import { CsvExportButton } from './table-csv-export.js';

interface VirtualTableProps<TData> {
  readonly data: readonly TData[];
  readonly columns: readonly TableColumn<TData>[];
  readonly sorting?: SortingState | undefined;
  readonly onSortingChange?: ((state: SortingState) => void) | undefined;
  readonly onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
  readonly renderExpandedRow?: ((row: TData) => React.ReactNode) | undefined;
  readonly loading?: boolean | undefined;
  readonly error?: string | null | undefined;
  readonly emptyMessage?: string | undefined;
  readonly height?: number | undefined;
  readonly rowHeight?: number | undefined;
  readonly overscan?: number | undefined;
  readonly totalRows?: number | undefined;
  readonly allColumns?: readonly TableColumn<TData>[] | undefined;
  readonly hiddenColumns?: readonly string[] | undefined;
  readonly autoHiddenKeys?: ReadonlySet<string> | undefined;
  readonly onHiddenColumnsChange?: ((next: readonly string[]) => void) | undefined;
  readonly onColumnOrderChange?: ((next: readonly string[]) => void) | undefined;
  readonly csvFilename?: string | undefined;
}

export function VirtualTable<TData>({
  data,
  columns,
  sorting,
  onSortingChange,
  onCellClick,
  renderExpandedRow,
  loading = false,
  error,
  emptyMessage = 'No rows match the current filters.',
  height = 600,
  rowHeight = 32,
  overscan = 10,
  totalRows,
  allColumns,
  hiddenColumns,
  autoHiddenKeys,
  onHiddenColumnsChange,
  onColumnOrderChange,
  csvFilename,
}: VirtualTableProps<TData>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const columnDefs = useMemo(() => toColumnDefs(columns), [columns]);
  const mutableData = useMemo(() => data.slice(), [data]);

  const tableOptions = useMemo(() => {
    const base = {
      data: mutableData,
      columns: columnDefs,
      state: { sorting: sorting ?? [] },
      getCoreRowModel: getCoreRowModel<TData>(),
      enableMultiSort: true,
      manualSorting: onSortingChange === undefined,
    };
    if (onSortingChange !== undefined) {
      const handler = onSortingChange;
      const currentSorting = sorting ?? [];
      return {
        ...base,
        getSortedRowModel: getSortedRowModel<TData>(),
        onSortingChange: (updater: SortingState | ((prev: SortingState) => SortingState)) => {
          const next = typeof updater === 'function' ? updater(currentSorting) : updater;
          handler(next);
        },
      };
    }
    return base;
  }, [mutableData, columnDefs, sorting, onSortingChange]);

  const table = useReactTable(tableOptions);
  const rows = table.getRowModel().rows;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const emptyAutoHidden = useMemo(() => new Set<string>(), []);
  const rowCount = data.length;
  const displayTotal = totalRows ?? rowCount;

  const headerRow = (
    <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
      <span>
        {rowCount === 0
          ? 'No rows'
          : <>
              Showing <span className="text-text-secondary tabular-nums">{rowCount.toLocaleString()}</span>
              {displayTotal > rowCount && (
                <> of <span className="text-text-secondary tabular-nums">{displayTotal.toLocaleString()}</span></>
              )}
              {' '}rows
            </>}
      </span>
      <div className="flex items-center gap-2">
        <span className="hidden md:inline text-text-muted">Click a cell to add that value to filters.</span>
        {csvFilename !== undefined && <CsvExportButton table={table} filename={csvFilename} />}
        {allColumns !== undefined && onHiddenColumnsChange !== undefined && onColumnOrderChange !== undefined && (
          <ColumnsPicker
            allColumns={allColumns}
            hiddenColumns={hiddenColumns ?? []}
            autoHiddenKeys={autoHiddenKeys ?? emptyAutoHidden}
            onChange={onHiddenColumnsChange}
            onOrderChange={onColumnOrderChange}
          />
        )}
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (error !== undefined && error !== null) {
    body = <div className="rounded-md border border-negative/40 bg-negative/5 text-xs text-negative px-3 py-2">{error}</div>;
  } else if (loading) {
    body = <CoinRainLoader height={260} count={7} />;
  } else if (rowCount === 0) {
    body = <div className="text-xs text-text-muted py-4 text-center">{emptyMessage}</div>;
  } else if (columns.length === 0) {
    body = <div className="text-xs text-text-muted py-4 text-center">All columns are hidden — open <em>Columns</em> to show some again.</div>;
  } else {
    body = (
      <div ref={scrollRef} className="border border-border rounded-md overflow-auto" style={{ height }}>
        <table className="text-[11px] w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-bg-tertiary/95 backdrop-blur-sm">
            {table.getHeaderGroups().map(headerGroup => (
              <tr key={headerGroup.id} className="text-left text-text-secondary">
                {headerGroup.headers.map(header => {
                  const meta = header.column.columnDef.meta;
                  const isSorted = header.column.getIsSorted();
                  const canSort = header.column.getCanSort();
                  const dirArrow = isSorted === 'asc' ? '\u2191' : isSorted === 'desc' ? '\u2193' : '';
                  return (
                    <th key={header.id} className="p-0 font-medium whitespace-nowrap">
                      {canSort ? (
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className={[
                            'w-full px-2 py-1.5 inline-flex items-center gap-1 hover:text-text-primary hover:bg-bg-secondary/40 cursor-pointer',
                            meta?.align === 'right' ? 'justify-end' : 'justify-start',
                            isSorted !== false ? 'text-text-primary' : '',
                          ].join(' ')}
                        >
                          <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                          <span className={`text-accent ${dirArrow.length > 0 ? '' : 'opacity-0'}`}>
                            {dirArrow.length > 0 ? dirArrow : '\u2195'}
                          </span>
                        </button>
                      ) : (
                        <span className={[
                          'w-full px-2 py-1.5 inline-flex items-center',
                          meta?.align === 'right' ? 'justify-end' : 'justify-start',
                        ].join(' ')}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                        </span>
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>
          <tbody style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualRow => {
              const row = rows[virtualRow.index];
              if (row === undefined) return null;
              const isExpanded = expandedIdx === virtualRow.index;
              return (
                <VirtualRow
                  key={row.id}
                  row={row}
                  virtualTop={virtualRow.start}
                  expanded={isExpanded}
                  onToggle={() => { setExpandedIdx(prev => prev === virtualRow.index ? null : virtualRow.index); }}
                  onCellClick={onCellClick}
                  renderExpandedRow={renderExpandedRow}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {headerRow}
      {body}
    </div>
  );
}

function VirtualRow<TData>({ row, virtualTop, expanded, onToggle, onCellClick, renderExpandedRow }: Readonly<{
  row: Row<TData>;
  virtualTop: number;
  expanded: boolean;
  onToggle: () => void;
  onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
  renderExpandedRow?: ((row: TData) => React.ReactNode) | undefined;
}>) {
  const canExpand = renderExpandedRow !== undefined;
  return (
    <>
      <tr
        className={[
          'border-t border-border/40',
          canExpand ? 'cursor-pointer' : '',
          expanded ? 'bg-bg-tertiary/40' : canExpand ? 'hover:bg-bg-tertiary/30' : '',
        ].join(' ')}
        style={{ position: 'absolute', top: virtualTop, width: '100%', display: 'table-row' }}
        onClick={canExpand ? onToggle : undefined}
      >
        {row.getVisibleCells().map(cell => (
          <VirtualCell key={cell.id} cell={cell} row={row} onCellClick={onCellClick} />
        ))}
      </tr>
      {expanded && renderExpandedRow !== undefined && (
        <tr className="bg-bg-tertiary/20" style={{ position: 'absolute', top: virtualTop + 32, width: '100%' }}>
          <td colSpan={row.getVisibleCells().length} className="px-3 py-2">
            {renderExpandedRow(row.original)}
          </td>
        </tr>
      )}
    </>
  );
}

function VirtualCell<TData>({ cell, row, onCellClick }: Readonly<{
  cell: Cell<TData, unknown>;
  row: Row<TData>;
  onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
}>) {
  const meta = cell.column.columnDef.meta;
  const classes = [
    'px-2 py-1 whitespace-nowrap',
    meta?.align === 'right' ? 'text-right' : '',
    meta?.mono === true ? 'tabular-nums font-mono' : '',
    meta?.truncate === true ? 'max-w-[260px] overflow-hidden text-ellipsis' : '',
  ].filter(c => c.length > 0).join(' ');

  const display = flexRender(cell.column.columnDef.cell, cell.getContext());
  const rawValue = cell.getValue();
  const dimId = meta?.dimId;
  const titleText = meta?.truncate === true && typeof rawValue === 'string' ? rawValue : undefined;

  if (onCellClick !== undefined && dimId !== undefined && dimId !== null && rawValue !== undefined && rawValue !== null && rawValue !== '') {
    return (
      <td className={classes} title={titleText}>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onCellClick(row.original, cell.column.id, rawValue); }}
          className="hover:underline hover:text-accent text-left"
          title={`Add "${typeof rawValue === 'string' ? rawValue : ''}" to filter`}
        >
          {display}
        </button>
      </td>
    );
  }

  return <td className={classes} title={titleText}>{display}</td>;
}
