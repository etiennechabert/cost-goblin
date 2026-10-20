import type { DimensionId, ViewSpec } from '@costgoblin/core/browser';

/** The group-bys of a page's charts, each on an enabled dimension. A chart
 *  grouped by a disabled dimension, or one no longer configured, would
 *  otherwise still query it: main resolves every configured dimension, and
 *  one outside the rollup grain is read from the raw Parquet. It moves instead
 *  to the first enabled dimension, in `enabledIds` order, that no other chart
 *  of the page groups by, so it doesn't repeat a chart already on screen; when
 *  every enabled dimension is taken, to the first one. With no `enabledIds`
 *  (dimensions not loaded) every group-by is kept. */
export function enabledGroupBys(wanted: readonly DimensionId[], enabledIds: readonly DimensionId[]): DimensionId[] {
  const first = enabledIds[0];
  if (first === undefined) return [...wanted];
  const enabled = new Set(enabledIds);
  const taken = new Set(wanted.filter(id => enabled.has(id)));
  return wanted.map(id => {
    if (enabled.has(id)) return id;
    const next = enabledIds.find(e => !taken.has(e)) ?? first;
    taken.add(next);
    return next;
  });
}

/** `spec` with every widget's group-by resolved by `enabledGroupBys`, the
 *  view's widgets in display order. Returns `spec` itself when none moves. */
export function withEnabledGroupBys(spec: ViewSpec, enabledIds: readonly DimensionId[]): ViewSpec {
  const wanted = spec.rows.flatMap(row => row.widgets.flatMap(w => ('groupBy' in w ? [w.groupBy] : [])));
  const resolved = enabledGroupBys(wanted, enabledIds);
  if (resolved.every((id, i) => id === wanted[i])) return spec;
  let next = 0;
  return {
    ...spec,
    rows: spec.rows.map(row => ({
      ...row,
      widgets: row.widgets.map(w => {
        if (!('groupBy' in w)) return w;
        const groupBy = resolved[next] ?? w.groupBy;
        next += 1;
        return groupBy === w.groupBy ? w : { ...w, groupBy };
      }),
    })),
  };
}
