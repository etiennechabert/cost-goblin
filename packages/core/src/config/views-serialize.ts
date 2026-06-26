import type { ViewSpec, ViewsConfig, WidgetSpec } from '../types/views.js';

function buildWidgetBase(w: WidgetSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { id: w.id, type: w.type, size: w.size };
  if (w.title !== undefined) base['title'] = w.title;
  return base;
}

function addGroupByFields(base: Record<string, unknown>, w: WidgetSpec & { groupBy: string }): void {
  base['groupBy'] = w.groupBy;
}

function addBubbleFields(base: Record<string, unknown>, w: WidgetSpec & { type: 'bubble' }): void {
  addGroupByFields(base, w);
  if (w.logScale !== undefined) base['logScale'] = w.logScale;
  if (w.deltaThreshold !== undefined) base['deltaThreshold'] = w.deltaThreshold;
  if (w.percentThreshold !== undefined) base['percentThreshold'] = w.percentThreshold;
}

/** YAML-ready shape for a single widget. Keeps keys in a stable order so
 *  round-tripping a config doesn't produce noisy diffs. */
export function widgetToYaml(w: WidgetSpec): Record<string, unknown> {
  const base = buildWidgetBase(w);
  switch (w.type) {
    case 'summary':
      if (w.metric !== undefined) base['metric'] = w.metric;
      return base;
    case 'pie':
    case 'stackedBar':
      addGroupByFields(base, w);
      return base;
    case 'bubble':
      addBubbleFields(base, w);
      return base;
    case 'treemap':
      addGroupByFields(base, w);
      if (w.drillTo !== undefined) base['drillTo'] = w.drillTo;
      return base;
    case 'line':
    case 'topNBar':
    case 'heatmap':
      addGroupByFields(base, w);
      if (w.topN !== undefined) base['topN'] = w.topN;
      return base;
    case 'table':
      if (w.enabledColumns !== undefined && w.enabledColumns.length > 0) base['enabledColumns'] = [...w.enabledColumns];
      return base;
  }
}

export function viewToYaml(v: ViewSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: v.id, name: v.name };
  if (v.icon !== undefined) out['icon'] = v.icon;
  if (v.builtIn === true) out['builtIn'] = true;
  out['rows'] = v.rows.map(r => ({ widgets: r.widgets.map(widgetToYaml) }));
  return out;
}

export function viewsConfigToYaml(cfg: ViewsConfig): { views: unknown[] } {
  return { views: cfg.views.map(viewToYaml) };
}
