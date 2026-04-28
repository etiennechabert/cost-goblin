import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  flexRender,
} from '@tanstack/react-table';
import type { SortingState, Row, Cell } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ExplorerTagColumn } from '@costgoblin/core/browser';
import { CoinRainLoader } from './coin-rain-loader.js';
import { CsvExportButton } from './table-csv-export.js';
import type { TableColumn } from '../lib/table-types.js';
import { toColumnDefs } from '../lib/table-types.js';

// ---------------------------------------------------------------------------
// ColumnSpec (backward compat — used by table-widget and explorer)
// ---------------------------------------------------------------------------

export interface ColumnSpec {
  readonly key: string;
  readonly label: string;
  readonly dimId: string | null;
  readonly align: 'left' | 'right';
  readonly mono?: boolean | undefined;
  readonly truncate?: boolean | undefined;
}

export const BASE_COLUMNS: readonly ColumnSpec[] = [
  { key: 'usage_date', label: 'Date', dimId: 'usage_date', align: 'left', mono: true },
  { key: 'usage_hour', label: 'Hour', dimId: 'usage_hour', align: 'left', mono: true },
  { key: 'cost', label: 'Cost', dimId: null, align: 'right', mono: true },
  { key: 'list_cost', label: 'List', dimId: null, align: 'right', mono: true },
  { key: 'service', label: 'Service', dimId: 'service', align: 'left' },
  { key: 'account_name', label: 'Account', dimId: 'account', align: 'left' },
  { key: 'line_item_type', label: 'Line type', dimId: 'line_item_type', align: 'left' },
  { key: 'region', label: 'Region', dimId: 'region', align: 'left', mono: true },
  { key: 'service_family', label: 'Family', dimId: 'service_family', align: 'left' },
  { key: 'usage_type', label: 'Usage type', dimId: 'usage_type', align: 'left', mono: true },
  { key: 'operation', label: 'Operation', dimId: 'operation', align: 'left' },
  { key: 'usage_amount', label: 'Usage', dimId: null, align: 'right', mono: true },
];

export const TRAILING_COLUMNS: readonly ColumnSpec[] = [
  { key: 'resource_id', label: 'Resource', dimId: 'resource_id', align: 'left', mono: true, truncate: true },
  { key: 'description', label: 'Description', dimId: 'description', align: 'left', truncate: true },
];

export function buildAllColumns(tagColumns: readonly ExplorerTagColumn[], granularity?: string): ColumnSpec[] {
  const base = granularity === 'hourly'
    ? BASE_COLUMNS
    : BASE_COLUMNS.filter(c => c.key !== 'usage_hour');
  const tagSpecs: ColumnSpec[] = tagColumns.map(t => ({
    key: t.id,
    label: t.label,
    dimId: t.id,
    align: 'left' as const,
  }));
  return [...base, ...tagSpecs, ...TRAILING_COLUMNS];
}

export function applyColumnOrder(
  columns: readonly ColumnSpec[],
  columnOrder: readonly string[],
): ColumnSpec[] {
  if (columnOrder.length === 0) return [...columns];
  const byKey = new Map(columns.map(c => [c.key, c]));
  const ordered: ColumnSpec[] = [];
  for (const key of columnOrder) {
    const col = byKey.get(key);
    if (col !== undefined) {
      ordered.push(col);
      byKey.delete(key);
    }
  }
  for (const col of columns) {
    if (byKey.has(col.key)) ordered.push(col);
  }
  return ordered;
}

export function filterVisibleColumns(
  columns: readonly ColumnSpec[],
  hiddenSet: ReadonlySet<string>,
  autoHiddenKeys: ReadonlySet<string>,
): ColumnSpec[] {
  return columns.filter(c => !hiddenSet.has(c.key) && !autoHiddenKeys.has(c.key));
}

// ---------------------------------------------------------------------------
// ColumnsPicker — drag-to-reorder column visibility toggle
// ---------------------------------------------------------------------------

interface ColumnsPickerProps<TData> {
  readonly allColumns: readonly TableColumn<TData>[];
  readonly hiddenColumns: readonly string[];
  readonly autoHiddenKeys: ReadonlySet<string>;
  readonly onChange: (next: readonly string[]) => void;
  readonly onOrderChange: (next: readonly string[]) => void;
}

export function ColumnsPicker<TData>({ allColumns, hiddenColumns, autoHiddenKeys, onChange, onOrderChange }: ColumnsPickerProps<TData>) {
  const [open, setOpen] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const visibleCount = allColumns.filter(c => !hiddenSet.has(c.id) && !autoHiddenKeys.has(c.id)).length;

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current !== null && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [open]);

  function toggle(id: string) {
    if (hiddenSet.has(id)) {
      onChange(hiddenColumns.filter(k => k !== id));
    } else {
      onChange([...hiddenColumns, id]);
    }
  }

  function handleDrop(targetKey: string) {
    if (draggedKey === null || draggedKey === targetKey) return;
    const keys = allColumns.map(c => c.id);
    const from = keys.indexOf(draggedKey);
    const to = keys.indexOf(targetKey);
    if (from === -1 || to === -1) return;
    const next = [...keys];
    next.splice(from, 1);
    next.splice(to, 0, draggedKey);
    onOrderChange(next);
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => { setOpen(prev => !prev); }}
        className="inline-flex items-center gap-1.5 rounded border border-border bg-bg-tertiary/30 px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary hover:border-border"
        title="Choose and reorder columns"
      >
        <span>Columns</span>
        <span className="tabular-nums text-text-muted">
          {String(visibleCount)}/{String(allColumns.length)}
        </span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-border bg-bg-secondary shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-[11px]">
            <span className="text-text-muted">Drag to reorder</span>
            <span className="flex items-center gap-2">
              <button type="button" onClick={() => { onChange([]); }} className="text-text-secondary hover:text-text-primary" disabled={hiddenColumns.length === 0}>Show all</button>
              <span className="text-text-muted">&middot;</span>
              <button type="button" onClick={() => { onChange(allColumns.map(c => c.id)); }} className="text-text-secondary hover:text-text-primary" disabled={hiddenColumns.length === allColumns.length}>Hide all</button>
              <span className="text-text-muted">&middot;</span>
              <button type="button" onClick={() => { onOrderChange([]); }} className="text-text-secondary hover:text-text-primary" title="Restore the default column order">Reset order</button>
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto py-1">
            {allColumns.map(col => {
              const checked = !hiddenSet.has(col.id);
              const autoHidden = autoHiddenKeys.has(col.id);
              const isDragging = draggedKey === col.id;
              const isDropTarget = dragOverKey === col.id && draggedKey !== null && draggedKey !== col.id;
              return (
                <label
                  key={col.id}
                  draggable
                  onDragStart={(e) => { setDraggedKey(col.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', col.id); }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKey !== col.id) setDragOverKey(col.id); }}
                  onDragLeave={() => { if (dragOverKey === col.id) setDragOverKey(null); }}
                  onDrop={(e) => { e.preventDefault(); handleDrop(col.id); setDragOverKey(null); setDraggedKey(null); }}
                  onDragEnd={() => { setDragOverKey(null); setDraggedKey(null); }}
                  className={[
                    'flex items-center gap-2 px-2 py-1.5 text-xs select-none cursor-default',
                    isDragging ? 'opacity-40' : '',
                    isDropTarget ? 'border-t-2 border-t-accent' : 'border-t-2 border-t-transparent',
                    'hover:bg-bg-tertiary',
                  ].join(' ')}
                >
                  <span className="cursor-grab text-text-muted hover:text-text-secondary" title="Drag to reorder">&loz;&loz;</span>
                  <input type="checkbox" className="accent-accent shrink-0" checked={checked} onChange={() => { toggle(col.id); }} />
                  <span className={['truncate flex-1', !checked || autoHidden ? 'text-text-muted' : 'text-text-primary'].join(' ')}>{col.header}</span>
                  {autoHidden && <span className="text-[10px] text-text-muted uppercase tracking-wider shrink-0" title="Hidden because this column is pinned to a single filter value">filtered</span>}
                  {!autoHidden && col.dimId !== undefined && col.dimId !== null && col.dimId.startsWith('tag_') && <span className="text-[10px] text-text-muted uppercase tracking-wider shrink-0">tag</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DataTable<TData> — generic TanStack Table with virtual scrolling
// ---------------------------------------------------------------------------

interface DataTableProps<TData> {
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
  readonly csvFilename?: string | undefined;
  // Column picker support
  readonly allColumns?: readonly TableColumn<TData>[] | undefined;
  readonly hiddenColumns?: readonly string[] | undefined;
  readonly autoHiddenKeys?: ReadonlySet<string> | undefined;
  readonly onHiddenColumnsChange?: ((next: readonly string[]) => void) | undefined;
  readonly onColumnOrderChange?: ((next: readonly string[]) => void) | undefined;
  // Slot for extra header content
  readonly headerRight?: React.ReactNode;
}

export function DataTable<TData>({
  data,
  columns,
  sorting,
  onSortingChange,
  onCellClick,
  renderExpandedRow,
  loading = false,
  error,
  emptyMessage = 'No rows match the current filters.',
  height = 560,
  rowHeight = 32,
  overscan = 10,
  totalRows,
  csvFilename,
  allColumns,
  hiddenColumns,
  autoHiddenKeys,
  onHiddenColumnsChange,
  onColumnOrderChange,
  headerRight,
}: DataTableProps<TData>) {
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

  const rowCount = data.length;
  const displayTotal = totalRows ?? rowCount;
  const emptyAutoHidden = useMemo(() => new Set<string>(), []);

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
        {headerRight}
        {csvFilename !== undefined && <CsvExportButton table={table} filename={csvFilename} />}
        {allColumns !== undefined && onHiddenColumnsChange !== undefined && onColumnOrderChange !== undefined && (
          <>
            <span className="hidden md:inline text-text-muted">Click a cell to add that value to filters.</span>
            <ColumnsPicker
              allColumns={allColumns}
              hiddenColumns={hiddenColumns ?? []}
              autoHiddenKeys={autoHiddenKeys ?? emptyAutoHidden}
              onChange={onHiddenColumnsChange}
              onOrderChange={onColumnOrderChange}
            />
          </>
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
          <TableBody
            virtualizer={virtualizer}
            rows={rows}
            expandedIdx={expandedIdx}
            setExpandedIdx={setExpandedIdx}
            onCellClick={onCellClick}
            renderExpandedRow={renderExpandedRow}
          />
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

// ---------------------------------------------------------------------------
// TableBody — padding-based virtual scrolling (rows stay in normal table flow)
// ---------------------------------------------------------------------------

import type { Virtualizer } from '@tanstack/react-virtual';

function TableBody<TData>({ virtualizer, rows, expandedIdx, setExpandedIdx, onCellClick, renderExpandedRow }: Readonly<{
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  rows: Row<TData>[];
  expandedIdx: number | null;
  setExpandedIdx: (fn: (prev: number | null) => number | null) => void;
  onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
  renderExpandedRow?: ((row: TData) => React.ReactNode) | undefined;
}>) {
  const virtualItems = virtualizer.getVirtualItems();
  const canExpand = renderExpandedRow !== undefined;

  if (virtualItems.length === 0) {
    return (
      <tbody>
        {rows.map((row, i) => {
          const isExpanded = expandedIdx === i;
          return (
            <TableRow
              key={row.id}
              row={row}
              expanded={isExpanded}
              canExpand={canExpand}
              onToggle={() => { setExpandedIdx(prev => prev === i ? null : i); }}
              onCellClick={onCellClick}
              renderExpandedRow={renderExpandedRow}
            />
          );
        })}
      </tbody>
    );
  }

  const firstItem = virtualItems[0];
  const lastItem = virtualItems[virtualItems.length - 1];
  const paddingTop = firstItem !== undefined ? firstItem.start : 0;
  const paddingBottom = lastItem !== undefined ? virtualizer.getTotalSize() - lastItem.end : 0;

  return (
    <tbody>
      {paddingTop > 0 && (
        <tr><td style={{ height: paddingTop, padding: 0, border: 'none' }} /></tr>
      )}
      {virtualItems.map(virtualRow => {
        const row = rows[virtualRow.index];
        if (row === undefined) return null;
        const isExpanded = expandedIdx === virtualRow.index;
        return (
          <TableRow
            key={row.id}
            row={row}
            expanded={isExpanded}
            canExpand={canExpand}
            onToggle={() => { setExpandedIdx(prev => prev === virtualRow.index ? null : virtualRow.index); }}
            onCellClick={onCellClick}
            renderExpandedRow={renderExpandedRow}
          />
        );
      })}
      {paddingBottom > 0 && (
        <tr><td style={{ height: paddingBottom, padding: 0, border: 'none' }} /></tr>
      )}
    </tbody>
  );
}

// ---------------------------------------------------------------------------
// TableRow + TableCell
// ---------------------------------------------------------------------------

function TableRow<TData>({ row, expanded, canExpand, onToggle, onCellClick, renderExpandedRow }: Readonly<{
  row: Row<TData>;
  expanded: boolean;
  canExpand: boolean;
  onToggle: () => void;
  onCellClick?: ((row: TData, columnId: string, value: unknown) => void) | undefined;
  renderExpandedRow?: ((row: TData) => React.ReactNode) | undefined;
}>) {
  return (
    <>
      <tr
        className={[
          'border-t border-border/40',
          canExpand ? 'cursor-pointer' : '',
          expanded ? 'bg-bg-tertiary/40' : canExpand ? 'hover:bg-bg-tertiary/30' : '',
        ].join(' ')}
        onClick={canExpand ? onToggle : undefined}
        onKeyDown={canExpand ? (e) => { if (e.key === 'Enter' || e.key === ' ') onToggle(); } : undefined}
        tabIndex={canExpand ? 0 : undefined}
        role="row"
      >
        {row.getVisibleCells().map(cell => (
          <TableCell key={cell.id} cell={cell} row={row} onCellClick={onCellClick} />
        ))}
      </tr>
      {expanded && renderExpandedRow !== undefined && (
        <tr className="bg-bg-tertiary/20">
          <td colSpan={row.getVisibleCells().length} className="px-3 py-2">
            {renderExpandedRow(row.original)}
          </td>
        </tr>
      )}
    </>
  );
}

function TableCell<TData>({ cell, row, onCellClick }: Readonly<{
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
