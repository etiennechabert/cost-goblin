import type { Dimension, WidgetSize, WidgetSpec, WidgetType } from '@costgoblin/core/browser';
import { asDimensionId } from '@costgoblin/core/browser';
import { getDimensionId, getDimensionLabel } from '../lib/dimensions.js';
import { WIDGET_CATALOG } from '../widgets/registry.js';

interface WidgetInspectorProps {
  readonly widget: WidgetSpec;
  readonly dimensions: readonly Dimension[];
  readonly onChange: (next: WidgetSpec) => void;
  readonly onDelete: () => void;
  readonly onMoveLeft?: (() => void) | undefined;
  readonly onMoveRight?: (() => void) | undefined;
}

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
      return { ...base, type };
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

    </div>
  );
}
