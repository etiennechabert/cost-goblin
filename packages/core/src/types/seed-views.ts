import { asDimensionId } from './branded.js';
import type { ViewSpec, ViewsConfig } from './views.js';

/** Default Cost Overview seed view, written to views.yaml on first run and
 *  used as a fallback whenever the file is missing or unreadable. Shared
 *  between desktop main (which seeds the file) and the renderer (which uses
 *  it as a render fallback). */
export const OVERVIEW_SEED_VIEW: ViewSpec = {
  id: 'overview',
  name: 'Cost Overview',
  builtIn: true,
  rows: [
    {
      widgets: [
        { id: 'overview-summary', type: 'summary', size: 'small', metric: 'total' },
        { id: 'overview-histogram', type: 'stackedBar', size: 'large', groupBy: asDimensionId('service') },
      ],
    },
    {
      widgets: [
        { id: 'overview-pie-account', type: 'pie', size: 'medium', groupBy: asDimensionId('account') },
        { id: 'overview-pie-region', type: 'pie', size: 'medium', groupBy: asDimensionId('region') },
        { id: 'overview-pie-service', type: 'pie', size: 'medium', groupBy: asDimensionId('service') },
      ],
    },
    {
      widgets: [
        {
          id: 'overview-breakdown',
          type: 'table',
          size: 'full',
          enabledColumns: ['cost', 'resource_id', 'description'],
        },
      ],
    },
  ],
};

/** One ready-made dashboard per widget type, so every widget has a default home
 *  the user can open, study, and clone. All group-bys use built-in dimensions
 *  (service / account / region / service_family) so the dashboards populate on
 *  any dataset regardless of which tag dimensions are configured. These are
 *  deletable (no `builtIn`) — pruning or duplicating them is encouraged — and
 *  the whole set is restored by "Reset built-ins". */
const WIDGET_SHOWCASE_VIEWS: readonly ViewSpec[] = [
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
          { id: 'topn-family', type: 'topNBar', size: 'medium', groupBy: asDimensionId('service_family'), topN: 12 },
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
          { id: 'dist-family', type: 'pie', size: 'medium', groupBy: asDimensionId('service_family') },
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
          { id: 'pv-family', type: 'priceVolume', size: 'full', groupBy: asDimensionId('service_family'), topN: 8 },
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

export const SEED_VIEWS_CONFIG: ViewsConfig = {
  views: [OVERVIEW_SEED_VIEW, ...WIDGET_SHOWCASE_VIEWS],
};
