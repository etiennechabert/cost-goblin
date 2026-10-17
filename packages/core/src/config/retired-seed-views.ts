import { asDimensionId } from '../types/branded.js';
import { SEED_VIEWS_CONFIG } from '../types/seed-views.js';
import type { ViewSpec, ViewsConfig } from '../types/views.js';
import { viewToYaml } from './views-serialize.js';

/** The per-widget-type showcase dashboards seeded built-in from #427 until the
 *  question-led set in SEED_VIEWS_CONFIG replaced them. Frozen exactly as they
 *  were last seeded (after the #526 service_family → service_category rename,
 *  which validateViews applies to older files on load), so an untouched copy in
 *  an existing views.yaml can be told apart from one the user edited. Never
 *  edit these: a change makes every untouched copy look edited. */
const RETIRED_SHOWCASE_VIEWS: readonly Omit<ViewSpec, 'builtIn'>[] = [
  {
    id: 'trend-lines',
    name: 'Trend lines',
    rows: [
      {
        widgets: [
          { id: 'trends-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'trends-line-service', type: 'line', size: 'large', groupBy: asDimensionId('service'), topN: 6 },
        ],
      },
      {
        widgets: [
          { id: 'trends-line-account', type: 'line', size: 'medium', groupBy: asDimensionId('account'), topN: 6 },
          { id: 'trends-line-region', type: 'line', size: 'medium', groupBy: asDimensionId('region'), topN: 6 },
        ],
      },
    ],
  },
  {
    id: 'stacked',
    name: 'Stacked over time',
    rows: [
      {
        widgets: [
          { id: 'stacked-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'stacked-service', type: 'stackedBar', size: 'large', groupBy: asDimensionId('service') },
        ],
      },
      {
        widgets: [
          { id: 'stacked-account', type: 'stackedBar', size: 'full', groupBy: asDimensionId('account') },
        ],
      },
    ],
  },
  {
    id: 'top-n',
    name: 'Top N',
    rows: [
      {
        widgets: [
          { id: 'topn-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'topn-service', type: 'topNBar', size: 'large', groupBy: asDimensionId('service'), topN: 12 },
        ],
      },
      {
        widgets: [
          { id: 'topn-account', type: 'topNBar', size: 'medium', groupBy: asDimensionId('account'), topN: 12 },
          { id: 'topn-family', type: 'topNBar', size: 'medium', groupBy: asDimensionId('service_category'), topN: 12 },
        ],
      },
    ],
  },
  {
    id: 'distribution',
    name: 'Distribution',
    rows: [
      {
        widgets: [
          { id: 'dist-account', type: 'pie', size: 'medium', groupBy: asDimensionId('account') },
          { id: 'dist-region', type: 'pie', size: 'medium', groupBy: asDimensionId('region') },
        ],
      },
      {
        widgets: [
          { id: 'dist-service', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
          { id: 'dist-family', type: 'pie', size: 'medium', groupBy: asDimensionId('service_category') },
        ],
      },
    ],
  },
  {
    id: 'treemap',
    name: 'Treemap',
    rows: [
      {
        widgets: [
          { id: 'treemap-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'treemap-service', type: 'treemap', size: 'large', groupBy: asDimensionId('service') },
        ],
      },
      {
        widgets: [
          { id: 'treemap-account', type: 'treemap', size: 'full', groupBy: asDimensionId('account') },
        ],
      },
    ],
  },
  {
    id: 'heatmap',
    name: 'Heatmap',
    rows: [
      {
        widgets: [
          { id: 'heatmap-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'heatmap-service', type: 'heatmap', size: 'large', groupBy: asDimensionId('service'), topN: 10 },
        ],
      },
      {
        widgets: [
          { id: 'heatmap-account', type: 'heatmap', size: 'full', groupBy: asDimensionId('account'), topN: 10 },
        ],
      },
    ],
  },
  {
    id: 'movers',
    name: 'Movers',
    rows: [
      {
        widgets: [
          { id: 'movers-summary', type: 'summary', size: 'small', metric: 'delta' },
          { id: 'movers-service', type: 'bubble', size: 'large', groupBy: asDimensionId('service') },
        ],
      },
      {
        widgets: [
          { id: 'movers-account', type: 'bubble', size: 'full', groupBy: asDimensionId('account') },
        ],
      },
    ],
  },
  {
    id: 'line-items',
    name: 'Line items',
    rows: [
      {
        widgets: [
          { id: 'items-total', type: 'summary', size: 'small', metric: 'total' },
          { id: 'items-delta', type: 'summary', size: 'small', metric: 'delta' },
          { id: 'items-count', type: 'summary', size: 'small', metric: 'entityCount' },
        ],
      },
      {
        widgets: [
          { id: 'items-table', type: 'table', size: 'full', enabledColumns: ['cost', 'service', 'account_name', 'resource_id', 'description'] },
        ],
      },
    ],
  },
  {
    id: 'drivers',
    name: 'Cost drivers',
    rows: [
      {
        widgets: [
          { id: 'drivers-summary', type: 'summary', size: 'small', metric: 'delta' },
          { id: 'drivers-service', type: 'waterfall', size: 'large', groupBy: asDimensionId('service'), topN: 8 },
        ],
      },
      {
        widgets: [
          { id: 'drivers-account', type: 'waterfall', size: 'full', groupBy: asDimensionId('account'), topN: 8 },
        ],
      },
    ],
  },
  {
    id: 'price-volume',
    name: 'Price vs volume',
    rows: [
      {
        widgets: [
          { id: 'pv-summary', type: 'summary', size: 'small', metric: 'delta' },
          { id: 'pv-service', type: 'priceVolume', size: 'large', groupBy: asDimensionId('service'), topN: 6 },
        ],
      },
      {
        widgets: [
          { id: 'pv-family', type: 'priceVolume', size: 'full', groupBy: asDimensionId('service_category'), topN: 8 },
        ],
      },
    ],
  },
  {
    id: 'pacing',
    name: 'Budget pacing',
    rows: [
      {
        widgets: [
          { id: 'pacing-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'pacing-burndown', type: 'burndown', size: 'large' },
        ],
      },
      {
        widgets: [
          { id: 'pacing-line', type: 'line', size: 'full', groupBy: asDimensionId('service'), topN: 6 },
        ],
      },
    ],
  },
  {
    id: 'concentration',
    name: 'Concentration',
    rows: [
      {
        widgets: [
          { id: 'conc-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'conc-service', type: 'pareto', size: 'large', groupBy: asDimensionId('service') },
        ],
      },
      {
        widgets: [
          { id: 'conc-account', type: 'pareto', size: 'full', groupBy: asDimensionId('account') },
        ],
      },
    ],
  },
];

const RETIRED_SEED_VIEWS_BY_ID: ReadonlyMap<string, ViewSpec> = new Map(
  RETIRED_SHOWCASE_VIEWS.map(v => [v.id, { ...v, builtIn: true }]),
);

/** Ids of the retired showcase dashboards. A new seed view must not reuse one,
 *  or the migration below would treat it as retired. */
export const RETIRED_SEED_VIEW_IDS: ReadonlySet<string> = new Set(RETIRED_SEED_VIEWS_BY_ID.keys());

function sameView(a: ViewSpec, b: ViewSpec): boolean {
  // viewToYaml emits keys in a fixed order and drops unset optionals, so equal
  // specs serialize identically however they were built.
  return JSON.stringify(viewToYaml(a)) === JSON.stringify(viewToYaml(b));
}

/** Insert every built-in seed view the list lacks where the seed order puts
 *  it: right after the nearest earlier seed view the list has, or first. */
function withMissingSeedViews(views: readonly ViewSpec[]): ViewSpec[] {
  const out = [...views];
  let insertAt = 0;
  for (const seed of SEED_VIEWS_CONFIG.views) {
    const existing = out.findIndex(v => v.id === seed.id);
    if (existing >= 0) {
      insertAt = existing + 1;
      continue;
    }
    if (seed.builtIn !== true) continue;
    out.splice(insertAt, 0, seed);
    insertAt += 1;
  }
  return out;
}

export interface SeedViewsMigration {
  readonly config: ViewsConfig;
  /** True when the config differs from the input and should be persisted. */
  readonly changed: boolean;
}

/** Bring a views config seeded by an older version onto the current built-in
 *  set. A retired showcase dashboard still marked built-in is dropped when
 *  untouched; one the user edited is kept as their own dashboard (no longer
 *  built-in, so they can delete it). Only a config that carried a retired
 *  dashboard gains the missing built-ins, so a file without one is returned
 *  as is. */
export function migrateRetiredSeedViews(config: ViewsConfig): SeedViewsMigration {
  let sawRetired = false;
  const kept: ViewSpec[] = [];
  for (const view of config.views) {
    const retired = view.builtIn === true ? RETIRED_SEED_VIEWS_BY_ID.get(view.id) : undefined;
    if (retired === undefined) {
      kept.push(view);
      continue;
    }
    sawRetired = true;
    if (!sameView(view, retired)) kept.push({ ...view, builtIn: undefined });
  }
  if (!sawRetired) return { config, changed: false };
  return { config: { views: withMissingSeedViews(kept) }, changed: true };
}
