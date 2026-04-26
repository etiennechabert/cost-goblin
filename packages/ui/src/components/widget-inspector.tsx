import { useMemo, useState } from 'react';
import type { Dimension, WidgetSize, WidgetSpec, WidgetType } from '@costgoblin/core/browser';
import { asDimensionId } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel, isTagDimension } from '../lib/dimensions.js';
import { WIDGET_CATALOG } from '../widgets/registry.js';
import { buildAllColumns, type ColumnSpec } from './data-table.js';
import { OVERVIEW_SEED_VIEW } from '@costgoblin/core/browser';

interface WidgetInspectorProps {
  readonly widget: WidgetSpec;
  readonly dimensions: readonly Dimension[];
  readonly onChange: (next: WidgetSpec) => void;
  readonly onDelete: () => void;
  readonly onMoveLeft?: (() => void) | undefined;
  readonly onMoveRight?: (() => void) | undefined;
}

const SEED_TABLE = OVERVIEW_SEED_VIEW.rows.flatMap(r => r.widgets).find(w => w.type === 'table');
const SEED_TABLE_HIDDEN = SEED_TABLE?.type === 'table' ? (SEED_TABLE.hiddenColumns ?? []) : [];
const SEED_TABLE_ORDER = SEED_TABLE?.type === 'table' ? (SEED_TABLE.columnOrder ?? []) : [];

const SIZES: readonly { value: WidgetSize; label: string }[] = [
  { value: 'small', label: 'S' },
  { value: 'medium', label: 'M' },
  { value: 'large', label: 'L' },
  { value: 'full', label: 'Full' },
];

function stripTitle(w: WidgetSpec): WidgetSpec {
  const common = {
    id: w.id,
    size: w.size,
    ...(w.filters !== undefined ? { filters: w.filters } : {}),
  };
  switch (w.type) {
    case 'summary':
      return { ...common, type: w.type, ...(w.metric !== undefined ? { metric: w.metric } : {}) };
    case 'pie':
      return { ...common, type: w.type, groupBy: w.groupBy };
    case 'stackedBar':
    case 'bubble':
      return { ...common, type: w.type, groupBy: w.groupBy };
    case 'treemap':
      return { ...common, type: w.type, groupBy: w.groupBy, ...(w.drillTo !== undefined ? { drillTo: w.drillTo } : {}) };
    case 'line':
    case 'topNBar':
    case 'heatmap':
      return { ...common, type: w.type, groupBy: w.groupBy, ...(w.topN !== undefined ? { topN: w.topN } : {}) };
    case 'table':
      return {
        ...common,
        type: w.type,
        ...(w.hiddenColumns !== undefined ? { hiddenColumns: w.hiddenColumns } : {}),
        ...(w.columnOrder !== undefined ? { columnOrder: w.columnOrder } : {}),
      };
  }
}

function defaultSpecForType(type: WidgetType, prev: WidgetSpec, fallbackDim: string): WidgetSpec {
  const base = { id: prev.id, size: prev.size, ...(prev.title !== undefined ? { title: prev.title } : {}) };
  const existingGroupBy = 'groupBy' in prev ? prev.groupBy : asDimensionId(fallbackDim);
  switch (type) {
    case 'summary':
      return { ...base, type };
    case 'pie':
      return { ...base, type, groupBy: existingGroupBy };
    case 'stackedBar':
    case 'bubble':
      return { ...base, type, groupBy: existingGroupBy };
    case 'treemap':
      return { ...base, type, groupBy: existingGroupBy };
    case 'line':
    case 'topNBar':
    case 'heatmap':
      return { ...base, type, groupBy: existingGroupBy, topN: 'topN' in prev && prev.topN !== undefined ? prev.topN : 10 };
    case 'table':
      return {
        ...base,
        type,
        columnOrder: [...SEED_TABLE_ORDER],
        hiddenColumns: [...SEED_TABLE_HIDDEN],
      };
  }
}

export function WidgetInspector({
  widget,
  dimensions,
  onChange,
  onDelete,
  onMoveLeft,
  onMoveRight,
}: WidgetInspectorProps) {
  const catalog = WIDGET_CATALOG.find(c => c.type === widget.type);
  const fallbackDim = dimensions[0] !== undefined ? getDimensionId(dimensions[0]) : 'service';

  function setSize(size: WidgetSize) {
    onChange({ ...widget, size });
  }

  function setTitle(title: string) {
    if (title === '') {
      onChange(stripTitle(widget));
    } else {
      onChange({ ...widget, title });
    }
  }

  function setType(value: string) {
    const match = WIDGET_CATALOG.find(c => c.type === value);
    if (match === undefined) return;
    onChange(defaultSpecForType(match.type, widget, fallbackDim));
  }

  function setGroupBy(value: string) {
    if (!('groupBy' in widget)) return;
    onChange({ ...widget, groupBy: asDimensionId(value) });
  }

  function setTopN(value: number) {
    if (widget.type === 'line' || widget.type === 'topNBar' || widget.type === 'heatmap') {
      onChange({ ...widget, topN: value });
    }
  }

  return (
    <div className="rounded-lg border border-border bg-bg-secondary/40 p-3 flex flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <select
          value={widget.type}
          onChange={(e) => { setType(e.target.value); }}
          className="bg-transparent border border-border rounded px-2 py-1 text-text-primary text-xs"
        >
          {WIDGET_CATALOG.map(c => (
            <option key={c.type} value={c.type}>{c.label}</option>
          ))}
        </select>
        <div className="flex items-center gap-0.5">
          {onMoveLeft !== undefined && (
            <button
              type="button"
              onClick={onMoveLeft}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50"
              title="Move left"
              aria-label="Move widget left"
            >
              ←
            </button>
          )}
          {onMoveRight !== undefined && (
            <button
              type="button"
              onClick={onMoveRight}
              className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-bg-tertiary/50"
              title="Move right"
              aria-label="Move widget right"
            >
              →
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="p-1 rounded text-text-muted hover:text-negative hover:bg-bg-tertiary/50"
            title="Remove widget"
            aria-label="Remove widget"
          >
            ✕
          </button>
        </div>
      </div>

      {catalog?.needsGroupBy === true && 'groupBy' in widget && (
        <label className="flex items-center gap-2">
          <span className="text-text-muted shrink-0 w-14">Group by</span>
          <select
            value={widget.groupBy}
            onChange={(e) => { setGroupBy(e.target.value); }}
            className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-text-primary"
          >
            {dimensions.map(d => (
              <option key={getDimensionId(d)} value={getDimensionId(d)}>
                {getDimensionLabel(d)}
              </option>
            ))}
          </select>
        </label>
      )}

      <label className="flex items-center gap-2">
        <span className="text-text-muted shrink-0 w-14">Size</span>
        <div className="flex items-center gap-0.5 rounded border border-border p-0.5">
          {SIZES.map(s => (
            <button
              key={s.value}
              type="button"
              onClick={() => { setSize(s.value); }}
              className={[
                'px-2 py-0.5 rounded text-[11px]',
                widget.size === s.value ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary',
              ].join(' ')}
            >
              {s.label}
            </button>
          ))}
        </div>
      </label>

      <label className="flex items-center gap-2">
        <span className="text-text-muted shrink-0 w-14">Title</span>
        <input
          type="text"
          value={widget.title ?? ''}
          onChange={(e) => { setTitle(e.target.value); }}
          placeholder="Auto"
          className="flex-1 bg-transparent border border-border rounded px-2 py-1 text-text-primary"
        />
      </label>

      {(widget.type === 'line' || widget.type === 'topNBar' || widget.type === 'heatmap') && (
        <label className="flex items-center gap-2">
          <span className="text-text-muted shrink-0 w-14">Top N</span>
          <input
            type="number"
            min={1}
            max={100}
            value={widget.topN ?? 10}
            onChange={(e) => {
              const v = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(v) && v > 0) setTopN(v);
            }}
            className="w-20 bg-transparent border border-border rounded px-2 py-1 text-text-primary"
          />
        </label>
      )}

      {widget.type === 'table' && (
        <TableColumnsEditor
          dimensions={dimensions}
          hiddenColumns={widget.hiddenColumns ?? []}
          columnOrder={widget.columnOrder ?? []}
          onHiddenChange={(next) => { onChange({ ...widget, hiddenColumns: next }); }}
          onOrderChange={(next) => { onChange({ ...widget, columnOrder: next }); }}
        />
      )}
    </div>
  );
}

function TableColumnsEditor({
  dimensions,
  hiddenColumns,
  columnOrder,
  onHiddenChange,
  onOrderChange,
}: {
  dimensions: readonly Dimension[];
  hiddenColumns: readonly string[];
  columnOrder: readonly string[];
  onHiddenChange: (next: readonly string[]) => void;
  onOrderChange: (next: readonly string[]) => void;
}) {
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dragOverKey, setDragOverKey] = useState<string | null>(null);

  const tagColumns = useMemo(
    () => dimensions.filter(d => isTagDimension(d)).map(d => ({ id: getDimensionId(d), label: getDimensionLabel(d) })),
    [dimensions],
  );

  const allColumns = useMemo(() => {
    const base = buildAllColumns(tagColumns);
    if (columnOrder.length === 0) return base;
    const byKey = new Map(base.map(c => [c.key, c]));
    const ordered: ColumnSpec[] = [];
    for (const key of columnOrder) {
      const col = byKey.get(key);
      if (col !== undefined) { ordered.push(col); byKey.delete(key); }
    }
    for (const col of base) {
      if (byKey.has(col.key)) ordered.push(col);
    }
    return ordered;
  }, [tagColumns, columnOrder]);

  const hiddenSet = useMemo(() => new Set(hiddenColumns), [hiddenColumns]);

  function toggle(key: string) {
    if (hiddenSet.has(key)) {
      onHiddenChange(hiddenColumns.filter(k => k !== key));
    } else {
      onHiddenChange([...hiddenColumns, key]);
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

  const allHidden = hiddenColumns.length >= allColumns.length;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-text-muted">Columns</span>
        <span className="flex items-center gap-2 text-[10px]">
          <button
            type="button"
            onClick={() => { onHiddenChange(allHidden ? [] : allColumns.map(c => c.key)); }}
            className="text-text-secondary hover:text-text-primary"
          >
            {allHidden ? 'Select all' : 'Deselect all'}
          </button>
          <span className="text-text-muted">·</span>
          <button type="button" onClick={() => { onOrderChange([]); onHiddenChange([]); }} className="text-text-secondary hover:text-text-primary">Reset</button>
        </span>
      </div>
      <div className="rounded border border-border max-h-48 overflow-y-auto">
        {allColumns.map(col => {
          const checked = !hiddenSet.has(col.key);
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
                'flex items-center gap-1.5 px-2 py-1 text-[11px] select-none',
                isDragging ? 'opacity-40' : '',
                isDropTarget ? 'border-t-2 border-t-accent' : 'border-t border-t-transparent',
                'hover:bg-bg-tertiary/50',
              ].join(' ')}
            >
              <span className="cursor-grab text-text-muted hover:text-text-secondary text-[10px]">⋮⋮</span>
              <input type="checkbox" className="accent-accent shrink-0" checked={checked} onChange={() => { toggle(col.key); }} />
              <span className={checked ? 'text-text-primary' : 'text-text-muted'}>{col.label}</span>
              {col.dimId !== null && col.dimId.startsWith('tag_') && <span className="text-[9px] text-text-muted uppercase tracking-wider ml-auto">tag</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
