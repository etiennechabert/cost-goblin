import { ipcMain } from 'electron';
import { writeFile } from 'node:fs/promises';
import { stringify } from 'yaml';
import { SEED_VIEWS_CONFIG, validateViews } from '@costgoblin/core';
import type { ViewsConfig, ViewSpec, WidgetSpec } from '@costgoblin/core';
import type { AppContext } from './context.js';

function widgetToYaml(w: WidgetSpec): Record<string, unknown> {
  const base: Record<string, unknown> = { id: w.id, type: w.type, size: w.size };
  if (w.title !== undefined) base['title'] = w.title;
  if (w.filters !== undefined) {
    const f: Record<string, string> = {};
    for (const [k, v] of Object.entries(w.filters)) {
      if (v !== undefined) f[k] = v;
    }
    base['filters'] = f;
  }
  switch (w.type) {
    case 'summary':
      if (w.metric !== undefined) base['metric'] = w.metric;
      return base;
    case 'pie':
      base['groupBy'] = w.groupBy;
      if (w.drillable === true) base['drillable'] = true;
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
      base['groupBy'] = w.groupBy;
      if (w.topN !== undefined) base['topN'] = w.topN;
      if (w.columns !== undefined) base['columns'] = [...w.columns];
      return base;
  }
}

function viewToYaml(v: ViewSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: v.id, name: v.name };
  if (v.icon !== undefined) out['icon'] = v.icon;
  if (v.builtIn === true) out['builtIn'] = true;
  out['rows'] = v.rows.map(r => ({ widgets: r.widgets.map(widgetToYaml) }));
  return out;
}

function configToYaml(cfg: ViewsConfig): { views: unknown[] } {
  return { views: cfg.views.map(viewToYaml) };
}

export function registerViewsHandlers(app: AppContext): void {
  const { ctx, getViews, invalidateViews } = app;

  ipcMain.handle('views:get-config', async (): Promise<ViewsConfig> => {
    try {
      return await getViews();
    } catch {
      // Missing / unreadable file → seed it lazily so first-run users get a
      // working dashboard without going through setup again.
      await writeFile(ctx.viewsPath, stringify(configToYaml(SEED_VIEWS_CONFIG)));
      invalidateViews();
      return SEED_VIEWS_CONFIG;
    }
  });

  ipcMain.handle('views:save-config', async (_event, raw: unknown): Promise<void> => {
    const validated = validateViews(raw);
    await writeFile(ctx.viewsPath, stringify(configToYaml(validated)));
    invalidateViews();
  });

  ipcMain.handle('views:reset-defaults', async (): Promise<ViewsConfig> => {
    await writeFile(ctx.viewsPath, stringify(configToYaml(SEED_VIEWS_CONFIG)));
    invalidateViews();
    return SEED_VIEWS_CONFIG;
  });
}
