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

/** Built-in dashboards beyond the overview, each answering one question by
 *  combining the widgets that answer it. Group-bys stick to account, region and
 *  service: the dimensions every provider populates (GCP has no
 *  service_category). Between them they use every widget type except baseline,
 *  which reads the Baselines page rather than the dashboard's filters and
 *  range. Marked built-in (see SEED_VIEWS_CONFIG) so the editor's "Reset
 *  built-ins" restores them; that reset only re-adds seed views flagged
 *  builtIn, leaving the user's own dashboards untouched. Ids must not reuse a
 *  retired seed id (RETIRED_SEED_VIEW_IDS in config/retired-seed-views.ts). */
const QUESTION_VIEWS: readonly Omit<ViewSpec, 'builtIn'>[] = [
  {
    id: 'what-changed',
    name: 'What changed',
    description: 'Why spend moved since the previous period: the drivers, usage vs price, and when it happened',
    rows: [
      {
        widgets: [
          { id: 'changed-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'changed-drivers-service', type: 'waterfall', size: 'large', groupBy: asDimensionId('service'), topN: 8 },
        ],
      },
      {
        widgets: [
          { id: 'changed-price-volume-service', type: 'priceVolume', size: 'medium', groupBy: asDimensionId('service'), topN: 6 },
          { id: 'changed-movers-account', type: 'bubble', size: 'medium', groupBy: asDimensionId('account') },
        ],
      },
      {
        widgets: [
          { id: 'changed-daily-service', type: 'heatmap', size: 'full', groupBy: asDimensionId('service'), topN: 10 },
        ],
      },
    ],
  },
  {
    id: 'spend-pacing',
    name: 'Spend pacing',
    description: 'Where this period is heading against the previous one, and the daily run rate behind it',
    rows: [
      {
        widgets: [
          { id: 'pacing-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'pacing-burndown', type: 'burndown', size: 'large' },
        ],
      },
      {
        widgets: [
          { id: 'pacing-run-rate-service', type: 'line', size: 'full', groupBy: asDimensionId('service'), topN: 6 },
        ],
      },
      {
        widgets: [
          { id: 'pacing-run-rate-account', type: 'stackedBar', size: 'full', groupBy: asDimensionId('account') },
        ],
      },
    ],
  },
  {
    id: 'where-the-money-goes',
    name: 'Where the money goes',
    description: 'Which few services, accounts and regions make up most of the bill',
    rows: [
      {
        widgets: [
          { id: 'money-summary', type: 'summary', size: 'small', metric: 'total' },
          { id: 'money-treemap-service', type: 'treemap', size: 'large', groupBy: asDimensionId('service') },
        ],
      },
      {
        widgets: [
          { id: 'money-concentration-service', type: 'pareto', size: 'medium', groupBy: asDimensionId('service') },
          { id: 'money-concentration-account', type: 'pareto', size: 'medium', groupBy: asDimensionId('account') },
        ],
      },
      {
        widgets: [
          { id: 'money-top-accounts', type: 'topNBar', size: 'medium', groupBy: asDimensionId('account'), topN: 12 },
          { id: 'money-top-regions', type: 'topNBar', size: 'medium', groupBy: asDimensionId('region'), topN: 12 },
        ],
      },
    ],
  },
];

export const SEED_VIEWS_CONFIG: ViewsConfig = {
  views: [OVERVIEW_SEED_VIEW, ...QUESTION_VIEWS.map(v => ({ ...v, builtIn: true }))],
};
