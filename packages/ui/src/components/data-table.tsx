import { useEffect, useMemo, useRef, useState } from 'react';
import type { ExplorerSampleRow, ExplorerSort, ExplorerTagColumn } from '@costgoblin/core/browser';
import { formatDollars } from './format.js';
import { CoinRainLoader } from './coin-rain-loader.js';

function formatSignedDollars(n: number): string {
  if (n < 0) return `-${formatDollars(-n)}`;
  return formatDollars(n);
}

export interface ColumnSpec {
  readonly key: string;
  readonly label: string;
  readonly dimId: string | null;
  readonly align: 'left' | 'right';
  readonly mono?: boolean;
  readonly truncate?: boolean;
}

export const BASE_COLUMNS: readonly ColumnSpec[] = [
  { key: 'usage_date', label: 'Date', dimId: null, align: 'left', mono: true },
  { key: 'usage_hour', label: 'Hour', dimId: null, align: 'left', mono: true },
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
  { key: 'description', label: 'Description', dimId: null, align: 'left', truncate: true },
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

// --- ColumnsPicker ---

interface ColumnsPickerProps {
  readonly allColumns: readonly ColumnSpec[];
  readonly hiddenColumns: readonly string[];
  readonly autoHiddenKeys: ReadonlySet<string>;
  readonly onChange: (next: readonly string[]) => void;
  readonly onOrderChange: (next: readonly string[]) => void;
}

export function ColumnsPicker({ allColumns, hiddenColumns, autoHiddenKeys, onChange, onOrderChange }: ColumnsPickerProps) {
  const [open, setOpen] = useState(false);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);
  const visibleCount = allColumns.filter(c => !hiddenSet.has(c.key) && !autoHiddenKeys.has(c.key)).length;

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

  function toggle(key: string) {
    if (hiddenSet.has(key)) {
      onChange(hiddenColumns.filter(k => k !== key));
    } else {
      onChange([...hiddenColumns, key]);
    }
  }

  function handleDrop(targetKey: string) {
    if (draggedKey === null || draggedKey === targetKey) return;
    const keys = allColumns.map(c => c.key);
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
              <span className="text-text-muted">·</span>
              <button type="button" onClick={() => { onChange(allColumns.map(c => c.key)); }} className="text-text-secondary hover:text-text-primary" disabled={hiddenColumns.length === allColumns.length}>Hide all</button>
              <span className="text-text-muted">·</span>
              <button type="button" onClick={() => { onOrderChange([]); }} className="text-text-secondary hover:text-text-primary" title="Restore the default column order">Reset order</button>
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto py-1">
            {allColumns.map(col => {
              const checked = !hiddenSet.has(col.key);
              const autoHidden = autoHiddenKeys.has(col.key);
              const isDragging = draggedKey === col.key;
              const isDropTarget = dragOverKey === col.key && draggedKey !== null && draggedKey !== col.key;
              return (
                <div
                  key={col.key}
                  draggable
                  onDragStart={(e) => { setDraggedKey(col.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', col.key); }}
                  onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverKey !== col.key) setDragOverKey(col.key); }}
                  onDragLeave={() => { if (dragOverKey === col.key) setDragOverKey(null); }}
                  onDrop={(e) => { e.preventDefault(); handleDrop(col.key); setDragOverKey(null); setDraggedKey(null); }}
                  onDragEnd={() => { setDragOverKey(null); setDraggedKey(null); }}
                  className={[
                    'flex items-center gap-2 px-2 py-1.5 text-xs select-none',
                    isDragging ? 'opacity-40' : '',
                    isDropTarget ? 'border-t-2 border-t-accent' : 'border-t-2 border-t-transparent',
                    'hover:bg-bg-tertiary',
                  ].join(' ')}
                >
                  <span className="cursor-grab text-text-muted hover:text-text-secondary" title="Drag to reorder">⋮⋮</span>
                  <input type="checkbox" className="accent-accent shrink-0" checked={checked} onChange={() => { toggle(col.key); }} />
                  <span className={['truncate flex-1', !checked || autoHidden ? 'text-text-muted' : 'text-text-primary'].join(' ')}>{col.label}</span>
                  {autoHidden && <span className="text-[10px] text-text-muted uppercase tracking-wider shrink-0" title="Hidden because this column is pinned to a single filter value">filtered</span>}
                  {!autoHidden && col.dimId !== null && col.dimId.startsWith('tag_') && <span className="text-[10px] text-text-muted uppercase tracking-wider shrink-0">tag</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// --- RowsTable ---

interface DataTableProps {
  readonly columns: readonly ColumnSpec[];
  readonly allColumns: readonly ColumnSpec[];
  readonly hiddenColumns: readonly string[];
  readonly autoHiddenKeys: ReadonlySet<string>;
  readonly onHiddenColumnsChange: (next: readonly string[]) => void;
  readonly onColumnOrderChange: (next: readonly string[]) => void;
  readonly rows: readonly ExplorerSampleRow[];
  readonly totalRows: number;
  readonly sort: ExplorerSort | undefined;
  readonly onSort: (columnKey: string) => void;
  readonly onFilterAdd: (dimId: string, value: string) => void;
  readonly loading: boolean;
  readonly error: string | null;
  readonly maxHeight?: string;
}

export function DataTable({ columns, allColumns, hiddenColumns, autoHiddenKeys, onHiddenColumnsChange, onColumnOrderChange, rows, totalRows, sort, onSort, onFilterAdd, loading, error, maxHeight = '560px' }: DataTableProps) {
  const headerRow = (
    <div className="flex items-center justify-between gap-3 text-xs text-text-muted">
      <span>
        {rows.length === 0
          ? 'No rows'
          : <>
              Showing <span className="text-text-secondary tabular-nums">{rows.length.toLocaleString()}</span>
              {totalRows > rows.length && (
                <> of <span className="text-text-secondary tabular-nums">{totalRows.toLocaleString()}</span></>
              )}
              {' '}rows
            </>}
      </span>
      <div className="flex items-center gap-3">
        <span className="hidden md:inline text-text-muted">Click a cell to add that value to filters.</span>
        <ColumnsPicker
          allColumns={allColumns}
          hiddenColumns={hiddenColumns}
          autoHiddenKeys={autoHiddenKeys}
          onChange={onHiddenColumnsChange}
          onOrderChange={onColumnOrderChange}
        />
      </div>
    </div>
  );

  let body: React.ReactNode;
  if (error !== null) {
    body = <div className="rounded-md border border-negative/40 bg-negative/5 text-xs text-negative px-3 py-2">{error}</div>;
  } else if (loading) {
    body = <CoinRainLoader height={260} count={7} />;
  } else if (rows.length === 0) {
    body = <div className="text-xs text-text-muted py-4 text-center">No rows match the current filters.</div>;
  } else if (columns.length === 0) {
    body = <div className="text-xs text-text-muted py-4 text-center">All columns are hidden — open <em>Columns</em> to show some again.</div>;
  } else {
    body = (
      <div className="border border-border rounded-md overflow-auto" style={{ maxHeight }}>
        <table className="text-[11px] w-full border-collapse">
          <thead className="sticky top-0 z-10 bg-bg-tertiary/95 backdrop-blur-sm">
            <tr className="text-left text-text-secondary">
              {columns.map(col => (
                <ColumnHeader key={col.key} spec={col} sort={sort} onSort={() => { onSort(col.key); }} />
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${String(i)}-${r.resourceId}-${r.date}`} className="border-t border-border/40 hover:bg-bg-tertiary/30">
                {columns.map(col => (
                  <RowCell key={col.key} spec={col} row={r} onFilterAdd={onFilterAdd} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="space-y-2" style={{ minHeight: maxHeight }}>
      {headerRow}
      {body}
    </div>
  );
}

// --- Header + Cell ---

function ColumnHeader({ spec, sort, onSort }: { spec: ColumnSpec; sort: ExplorerSort | undefined; onSort: () => void }) {
  const isSorted = sort?.column === spec.key;
  const indicator = isSorted ? (sort.direction === 'asc' ? '↑' : '↓') : '';
  return (
    <th className="p-0 font-medium whitespace-nowrap">
      <button
        type="button"
        onClick={onSort}
        className={[
          'w-full px-2 py-1.5 inline-flex items-center gap-1 hover:text-text-primary hover:bg-bg-secondary/40 cursor-pointer',
          spec.align === 'right' ? 'justify-end' : 'justify-start',
          isSorted ? 'text-text-primary' : '',
        ].join(' ')}
      >
        <span>{spec.label}</span>
        <span className={`text-accent ${indicator.length > 0 ? '' : 'opacity-0'}`}>
          {indicator.length > 0 ? indicator : '↕'}
        </span>
      </button>
    </th>
  );
}

function RowCell({ spec, row, onFilterAdd }: { spec: ColumnSpec; row: ExplorerSampleRow; onFilterAdd: (dimId: string, value: string) => void }) {
  const display = renderCell(spec, row);
  const rawValue = filterValueFor(spec, row);
  const titleText = spec.truncate === true ? stringValueFor(spec, row) : undefined;
  const classes = [
    'px-2 py-1 whitespace-nowrap',
    spec.align === 'right' ? 'text-right' : '',
    spec.mono === true ? 'tabular-nums font-mono' : '',
    spec.truncate === true ? 'max-w-[260px] overflow-hidden text-ellipsis' : '',
  ].filter(c => c.length > 0).join(' ');

  if (spec.dimId !== null && rawValue !== null && rawValue.length > 0) {
    const dimId = spec.dimId;
    return (
      <td className={classes} title={titleText}>
        <button type="button" onClick={() => { onFilterAdd(dimId, rawValue); }} className="hover:underline hover:text-accent text-left" title={`Add "${rawValue}" to ${spec.label} filter`}>
          {display}
        </button>
      </td>
    );
  }
  return <td className={classes} title={titleText}>{display}</td>;
}

function stringValueFor(spec: ColumnSpec, row: ExplorerSampleRow): string {
  switch (spec.key) {
    case 'resource_id': return row.resourceId;
    case 'description': return row.description;
    default: return row.tags[spec.key] ?? '';
  }
}

function renderCell(spec: ColumnSpec, row: ExplorerSampleRow): React.ReactNode {
  switch (spec.key) {
    case 'usage_date': return row.date;
    case 'usage_hour': {
      if (row.hour.length === 0) return '';
      const time = row.hour.includes(' ') ? row.hour.split(' ')[1] ?? row.hour : row.hour;
      return time.slice(0, 8);
    }
    case 'cost': {
      const cls = row.cost < 0 ? 'text-warning' : '';
      return <span className={cls}>{formatSignedDollars(row.cost)}</span>;
    }
    case 'list_cost': return formatSignedDollars(row.listCost);
    case 'service': return row.service;
    case 'account_name': return row.accountName.length > 0 ? row.accountName : row.accountId;
    case 'line_item_type': return row.lineItemType;
    case 'region': return row.region;
    case 'service_family': return row.serviceFamily;
    case 'usage_type': return row.usageType;
    case 'operation': return row.operation;
    case 'usage_amount': return row.usageAmount === 0 ? '' : row.usageAmount.toLocaleString(undefined, { maximumFractionDigits: 4 });
    case 'resource_id': return row.resourceId;
    case 'description': return row.description;
    default: return row.tags[spec.key] ?? '';
  }
}

function filterValueFor(spec: ColumnSpec, row: ExplorerSampleRow): string | null {
  switch (spec.key) {
    case 'service': return row.service;
    case 'account_name': return row.accountName.length > 0 ? row.accountName : row.accountId;
    case 'line_item_type': return row.lineItemType;
    case 'region': return row.region;
    case 'service_family': return row.serviceFamily;
    case 'usage_type': return row.usageType;
    case 'operation': return row.operation;
    case 'resource_id': return row.resourceId.length > 0 ? row.resourceId : null;
    default: {
      if (spec.dimId !== null && spec.dimId.startsWith('tag_')) {
        const v = row.tags[spec.key];
        return v === undefined || v.length === 0 ? null : v;
      }
      return null;
    }
  }
}
