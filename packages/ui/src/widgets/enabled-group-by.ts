import type { DimensionId, ViewSpec, WidgetSpec } from '@costgoblin/core/browser';

/** `spec` with every widget grouped by an enabled dimension. A widget whose
 *  group-by is disabled, or no longer configured, would otherwise still query
 *  it: main resolves every configured dimension, and one outside the rollup
 *  grain is read from the raw Parquet. It moves instead to the first enabled
 *  dimension, in `enabledIds` order, that no other widget of the view groups
 *  by, so it doesn't repeat a chart already on screen; when every enabled
 *  dimension is taken, to the first one. Returns `spec` itself when every
 *  group-by is enabled, or when `enabledIds` is empty (dimensions not
 *  loaded). */
export function withEnabledGroupBys(spec: ViewSpec, enabledIds: readonly DimensionId[]): ViewSpec {
  const first = enabledIds[0];
  if (first === undefined) return spec;
  const enabled = new Set(enabledIds);
  const groupBys = spec.rows.flatMap(row => row.widgets.flatMap(w => ('groupBy' in w ? [w.groupBy] : [])));
  if (groupBys.every(id => enabled.has(id))) return spec;

  const taken = new Set(groupBys.filter(id => enabled.has(id)));
  const replace = (w: WidgetSpec): WidgetSpec => {
    if (!('groupBy' in w) || enabled.has(w.groupBy)) return w;
    const groupBy = enabledIds.find(id => !taken.has(id)) ?? first;
    taken.add(groupBy);
    return { ...w, groupBy };
  };
  return { ...spec, rows: spec.rows.map(row => ({ ...row, widgets: row.widgets.map(replace) })) };
}
