import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { asDimensionId } from '@costgoblin/core/browser';
import type {
  Dimension,
  ViewSpec,
  ViewsConfig,
  WidgetSpec,
} from '@costgoblin/core/browser';
import { useCostApi } from '../hooks/use-cost-api.js';
import { useQuery } from '../hooks/use-query.js';
import { CustomView } from './custom-view.js';
import { WidgetInspector } from '../components/widget-inspector.js';
import { WIDGET_CATALOG } from '../widgets/registry.js';
import { getDimensionId } from '../lib/dimensions.js';

interface IdGen { count: number }

function nextId(prefix: string, gen: IdGen): string {
  gen.count += 1;
  return `${prefix}-${Date.now().toString(36)}-${gen.count.toString(36)}`;
}

function makeBlankView(gen: IdGen): ViewSpec {
  return {
    id: nextId('view', gen),
    name: 'New view',
    rows: [
      {
        widgets: [
          { id: nextId('w', gen), type: 'summary', size: 'small' },
        ],
      },
    ],
  };
}

function makeBlankWidget(gen: IdGen, fallbackDim: string): WidgetSpec {
  return {
    id: nextId('w', gen),
    type: 'pie',
    size: 'medium',
    groupBy: asDimensionId(fallbackDim),
  };
}

interface EditorState {
  readonly config: ViewsConfig;
  readonly selectedViewId: string | null;
  readonly dirty: boolean;
}

export function ViewsEditor(): React.JSX.Element {
  const api = useCostApi();
  const idGenRef = useRef({ count: 0 });
  const idGen = idGenRef.current;

  const [state, setState] = useState<EditorState>({
    config: { views: [] },
    selectedViewId: null,
    dirty: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dimensionsQuery = useQuery(() => api.getDimensions(), [api]);
  const dimensions: readonly Dimension[] = dimensionsQuery.status === 'success' ? dimensionsQuery.data : [];
  const fallbackDim = dimensions[0] !== undefined ? getDimensionId(dimensions[0]) : 'service';

  useEffect(() => {
    let cancelled = false;
    api.getViewsConfig().then(cfg => {
      if (cancelled) return;
      setState({
        config: cfg,
        selectedViewId: cfg.views[0]?.id ?? null,
        dirty: false,
      });
    }).catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    });
    return () => { cancelled = true; };
  }, [api]);

  const selectedView = state.config.views.find(v => v.id === state.selectedViewId) ?? null;
  // Defer the spec passed to the preview so typing in the title input doesn't
  // refire every widget's useQuery on each keystroke.
  const previewSpec = useDeferredValue(selectedView);

  function updateConfig(next: ViewsConfig, selectedViewId: string | null = state.selectedViewId): void {
    setState({ config: next, selectedViewId, dirty: true });
  }

  function updateSelectedView(updater: (v: ViewSpec) => ViewSpec): void {
    if (selectedView === null) return;
    const newViews = state.config.views.map(v => v.id === selectedView.id ? updater(v) : v);
    updateConfig({ views: newViews });
  }

  function addView(): void {
    const v = makeBlankView(idGen);
    updateConfig({ views: [...state.config.views, v] }, v.id);
  }

  function deleteView(viewId: string): void {
    const view = state.config.views.find(v => v.id === viewId);
    if (view?.builtIn === true) return;
    const newViews = state.config.views.filter(v => v.id !== viewId);
    const newSelectedId = newViews[0]?.id ?? null;
    updateConfig({ views: newViews }, newSelectedId);
  }

  function moveView(viewId: string, dir: -1 | 1): void {
    const idx = state.config.views.findIndex(v => v.id === viewId);
    if (idx < 0) return;
    const target = idx + dir;
    if (target < 0 || target >= state.config.views.length) return;
    const newViews = [...state.config.views];
    const [moved] = newViews.splice(idx, 1);
    if (moved !== undefined) newViews.splice(target, 0, moved);
    updateConfig({ views: newViews });
  }

  function setViewName(name: string): void {
    updateSelectedView(v => ({ ...v, name }));
  }

  function addRow(): void {
    updateSelectedView(v => ({
      ...v,
      rows: [...v.rows, { widgets: [makeBlankWidget(idGen, fallbackDim)] }],
    }));
  }

  function deleteRow(rowIdx: number): void {
    updateSelectedView(v => ({
      ...v,
      rows: v.rows.filter((_, i) => i !== rowIdx),
    }));
  }

  function moveRow(rowIdx: number, dir: -1 | 1): void {
    updateSelectedView(v => {
      const target = rowIdx + dir;
      if (target < 0 || target >= v.rows.length) return v;
      const next = [...v.rows];
      const [moved] = next.splice(rowIdx, 1);
      if (moved !== undefined) next.splice(target, 0, moved);
      return { ...v, rows: next };
    });
  }

  function addWidget(rowIdx: number): void {
    updateSelectedView(v => ({
      ...v,
      rows: v.rows.map((r, i) =>
        i === rowIdx ? { widgets: [...r.widgets, makeBlankWidget(idGen, fallbackDim)] } : r,
      ),
    }));
  }

  function updateWidget(rowIdx: number, widgetIdx: number, w: WidgetSpec): void {
    updateSelectedView(v => ({
      ...v,
      rows: v.rows.map((r, i) =>
        i === rowIdx
          ? { widgets: r.widgets.map((ww, j) => j === widgetIdx ? w : ww) }
          : r,
      ),
    }));
  }

  function deleteWidget(rowIdx: number, widgetIdx: number): void {
    updateSelectedView(v => ({
      ...v,
      rows: v.rows.map((r, i) =>
        i === rowIdx
          ? { widgets: r.widgets.filter((_, j) => j !== widgetIdx) }
          : r,
      ),
    }));
  }

  function moveWidget(rowIdx: number, widgetIdx: number, dir: -1 | 1): void {
    updateSelectedView(v => ({
      ...v,
      rows: v.rows.map((r, i) => {
        if (i !== rowIdx) return r;
        const target = widgetIdx + dir;
        if (target < 0 || target >= r.widgets.length) return r;
        const next = [...r.widgets];
        const [moved] = next.splice(widgetIdx, 1);
        if (moved !== undefined) next.splice(target, 0, moved);
        return { widgets: next };
      }),
    }));
  }

  async function handleSave(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      await api.saveViewsConfig(state.config);
      setState(prev => ({ ...prev, dirty: false }));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleReset(): Promise<void> {
    if (!window.confirm('Reset to default views? This will discard all custom views and unsaved changes.')) return;
    setSaving(true);
    try {
      const cfg = await api.resetViewsConfig();
      setState({ config: cfg, selectedViewId: cfg.views[0]?.id ?? null, dirty: false });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-primary">Views</h2>
          <p className="text-sm text-text-secondary mt-0.5">Compose dashboards from the widget library</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => { void handleReset(); }}
            disabled={saving}
            className="px-3 py-1.5 text-sm rounded-md border border-border text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            Reset to defaults
          </button>
          <button
            type="button"
            onClick={() => { void handleSave(); }}
            disabled={saving || !state.dirty}
            className="px-4 py-1.5 text-sm rounded-md bg-accent text-bg-primary font-medium hover:opacity-90 disabled:opacity-40"
          >
            {saving ? 'Saving…' : state.dirty ? 'Save changes' : 'Saved'}
          </button>
        </div>
      </div>

      {error !== null && (
        <div className="rounded-lg border border-negative/50 bg-negative-muted px-3 py-2 text-sm text-negative">
          {error}
        </div>
      )}

      <div className="grid gap-4" style={{ gridTemplateColumns: '240px 1fr' }}>
        {/* Left pane: view list */}
        <div className="flex flex-col gap-1 rounded-lg border border-border bg-bg-secondary/30 p-2">
          {state.config.views.map((v, i) => {
            const isSelected = v.id === state.selectedViewId;
            return (
              <div
                key={v.id}
                className={[
                  'rounded px-2 py-1.5 flex items-center gap-1 group',
                  isSelected ? 'bg-bg-tertiary' : 'hover:bg-bg-tertiary/30',
                ].join(' ')}
              >
                <button
                  type="button"
                  onClick={() => { setState(prev => ({ ...prev, selectedViewId: v.id })); }}
                  className="flex-1 text-left text-sm text-text-primary truncate"
                >
                  {v.name}
                  {v.builtIn === true && <span className="ml-1 text-[10px] text-text-muted">built-in</span>}
                </button>
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
                  <button
                    type="button"
                    onClick={() => { moveView(v.id, -1); }}
                    disabled={i === 0}
                    className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
                    aria-label="Move view up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={() => { moveView(v.id, 1); }}
                    disabled={i === state.config.views.length - 1}
                    className="p-0.5 text-text-muted hover:text-text-primary disabled:opacity-30"
                    aria-label="Move view down"
                  >
                    ↓
                  </button>
                  {v.builtIn !== true && (
                    <button
                      type="button"
                      onClick={() => { deleteView(v.id); }}
                      className="p-0.5 text-text-muted hover:text-negative"
                      aria-label="Delete view"
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addView}
            className="mt-1 px-2 py-1.5 text-sm rounded text-text-secondary hover:text-text-primary hover:bg-bg-tertiary/30 text-left"
          >
            + New view
          </button>
        </div>

        {/* Right pane: edit selected view */}
        <div className="flex flex-col gap-3">
          {selectedView === null ? (
            <div className="rounded-lg border border-border bg-bg-secondary/30 p-6 text-sm text-text-muted text-center">
              Pick a view on the left, or create a new one.
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={selectedView.name}
                  onChange={(e) => { setViewName(e.target.value); }}
                  className="flex-1 bg-transparent border border-border rounded px-3 py-1.5 text-text-primary"
                />
                <span className="text-xs text-text-muted">{WIDGET_CATALOG.length} widget types available</span>
              </div>

              {selectedView.rows.map((row, rowIdx) => (
                <div key={rowIdx} className="rounded-lg border border-border bg-bg-secondary/30 p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-muted">Row {String(rowIdx + 1)}</span>
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => { moveRow(rowIdx, -1); }}
                        disabled={rowIdx === 0}
                        className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                        aria-label="Move row up"
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        onClick={() => { moveRow(rowIdx, 1); }}
                        disabled={rowIdx === selectedView.rows.length - 1}
                        className="p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                        aria-label="Move row down"
                      >
                        ↓
                      </button>
                      <button
                        type="button"
                        onClick={() => { deleteRow(rowIdx); }}
                        className="p-1 text-text-muted hover:text-negative"
                        aria-label="Delete row"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {row.widgets.map((w, widgetIdx) => (
                      <div key={w.id} style={{ width: 280 }}>
                        <WidgetInspector
                          widget={w}
                          dimensions={dimensions}
                          onChange={(next) => { updateWidget(rowIdx, widgetIdx, next); }}
                          onDelete={() => { deleteWidget(rowIdx, widgetIdx); }}
                          onMoveLeft={widgetIdx > 0 ? () => { moveWidget(rowIdx, widgetIdx, -1); } : undefined}
                          onMoveRight={widgetIdx < row.widgets.length - 1 ? () => { moveWidget(rowIdx, widgetIdx, 1); } : undefined}
                        />
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => { addWidget(rowIdx); }}
                      className="rounded-lg border border-dashed border-border bg-bg-secondary/30 px-3 py-2 text-xs text-text-muted hover:text-text-primary hover:border-text-secondary self-stretch"
                      style={{ width: 100 }}
                    >
                      + Widget
                    </button>
                  </div>
                </div>
              ))}

              <button
                type="button"
                onClick={addRow}
                className="rounded-lg border border-dashed border-border bg-bg-secondary/30 px-3 py-2 text-sm text-text-muted hover:text-text-primary hover:border-text-secondary"
              >
                + Add row
              </button>

              <div className="mt-4">
                <div className="border-b border-border pb-1 mb-2">
                  <h3 className="text-xs uppercase tracking-wider text-text-muted">Preview</h3>
                </div>
                <div className="rounded-lg border border-border bg-bg-primary">
                  {previewSpec !== null && <CustomView spec={previewSpec} />}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
