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
          groupBy: asDimensionId('account'),
          columns: ['entity', 'service', 'cost', 'percentage'],
          topN: 20,
        },
      ],
    },
  ],
};

export const SEED_VIEWS_CONFIG: ViewsConfig = {
  views: [OVERVIEW_SEED_VIEW],
};
