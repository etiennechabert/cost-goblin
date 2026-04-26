import type { ViewSpec, ViewsConfig, WidgetSpec } from '../types/views.js';

/** YAML-ready shape for a single widget. Keeps keys in a stable order so
 *  round-tripping a config doesn't produce noisy diffs. */
export function widgetToYaml(w: WidgetSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { id: w.id, type: w.type, size: w.size };
  if (w.title !== undefined) base['title'] = w.title;
  if (w.filters !== undefined) {
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.filters)) {
      if (v !== undefined) f[k] = v;
    }
    if (Object.keys(f).length > 0) base['filters'] = f;
  }
  switch (w.type) {
    case 'summary':
      if (w.metric !== undefined) base['metric'] = w.metric;
      return base;
    case 'pie':
      base['groupBy'] = w.groupBy;
      return base;
    case 'stackedBar':
    case 'bubble':
      base['groupBy'] = w.groupBy;
      return base;
    case 'treemap':
      base['groupBy'] = w.groupBy;
      if (w.drillTo !== undefined) base['drillTo'] = w.drillTo;
      return base;
    case 'line':
    case 'topNBar':
    case 'heatmap':
      base['groupBy'] = w.groupBy;
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
