import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { viewsConfigToYaml, widgetToYaml } from '../config/views-serialize.js';
import { validateViews } from '../config/views-validator.js';
import { asDimensionId } from '../types/branded.js';
import type { ViewSpec, ViewsConfig, WidgetSpec, WidgetType } from '../types/views.js';

/** Every optional field present. Typing the fixtures with it means a field
 *  added to a view or a widget type fails to compile here until the fixture
 *  sets it, then fails the round trip until the validator and the serializer
 *  both carry it (both used to drop the pie's `showLegend`). */
type FullySpecified<T> = { readonly [K in keyof T]-?: Exclude<T[K], undefined> };

type EveryField = { readonly [T in WidgetType]: FullySpecified<Extract<WidgetSpec, { type: T }>> };
type RequiredOnly = { readonly [T in WidgetType]: Extract<WidgetSpec, { type: T }> };

const service = asDimensionId('service');
const account = asDimensionId('account');
const region = asDimensionId('region');

// Values differ from each field's default, so one that reloads as the
// default can't pass by accident.
const EVERY_FIELD: EveryField = {
  summary: { id: 'summary', type: 'summary', size: 'small', title: 'Spend', metric: 'topEntity', groupBy: region },
  pie: { id: 'pie', type: 'pie', size: 'medium', title: 'Share', groupBy: service, showLegend: false },
  stackedBar: { id: 'stackedBar', type: 'stackedBar', size: 'large', title: 'Daily', groupBy: account },
  line: { id: 'line', type: 'line', size: 'large', title: 'Trend', groupBy: service, topN: 4 },
  topNBar: { id: 'topNBar', type: 'topNBar', size: 'medium', title: 'Top', groupBy: account, topN: 7 },
  treemap: { id: 'treemap', type: 'treemap', size: 'medium', title: 'Map', groupBy: service, drillTo: region },
  heatmap: { id: 'heatmap', type: 'heatmap', size: 'full', title: 'Heat', groupBy: region, topN: 12 },
  bubble: {
    id: 'bubble', type: 'bubble', size: 'large', title: 'Movers', groupBy: service,
    logScale: 'linear', deltaThreshold: 25, percentThreshold: 5,
  },
  table: { id: 'table', type: 'table', size: 'full', title: 'Items', enabledColumns: ['cost', 'service', 'region'] },
  baseline: { id: 'baseline', type: 'baseline', size: 'medium', title: 'Baselines', topN: 3 },
  waterfall: { id: 'waterfall', type: 'waterfall', size: 'large', title: 'Drivers', groupBy: service, topN: 5 },
  priceVolume: { id: 'priceVolume', type: 'priceVolume', size: 'large', title: 'Price/volume', groupBy: service, topN: 4 },
  burndown: { id: 'burndown', type: 'burndown', size: 'medium', title: 'Budget', budget: 1200 },
  pareto: { id: 'pareto', type: 'pareto', size: 'medium', title: '80/20', groupBy: account },
};

const REQUIRED_ONLY: RequiredOnly = {
  summary: { id: 'summary', type: 'summary', size: 'small' },
  pie: { id: 'pie', type: 'pie', size: 'medium', groupBy: service },
  stackedBar: { id: 'stackedBar', type: 'stackedBar', size: 'large', groupBy: account },
  line: { id: 'line', type: 'line', size: 'large', groupBy: service },
  topNBar: { id: 'topNBar', type: 'topNBar', size: 'medium', groupBy: account },
  treemap: { id: 'treemap', type: 'treemap', size: 'medium', groupBy: service },
  heatmap: { id: 'heatmap', type: 'heatmap', size: 'full', groupBy: region },
  bubble: { id: 'bubble', type: 'bubble', size: 'large', groupBy: service },
  table: { id: 'table', type: 'table', size: 'full' },
  baseline: { id: 'baseline', type: 'baseline', size: 'medium' },
  waterfall: { id: 'waterfall', type: 'waterfall', size: 'large', groupBy: service },
  priceVolume: { id: 'priceVolume', type: 'priceVolume', size: 'large', groupBy: service },
  burndown: { id: 'burndown', type: 'burndown', size: 'medium' },
  pareto: { id: 'pareto', type: 'pareto', size: 'medium', groupBy: account },
};

function configOf(widgets: readonly WidgetSpec[]): ViewsConfig {
  return { views: [{ id: 'v', name: 'V', rows: [{ widgets }] }] };
}

/** The desktop round trip: `views:save-config` writes
 *  `stringify(viewsConfigToYaml(...))`, and `loadViews` parses and validates it. */
function saveAndReload(cfg: ViewsConfig): ViewsConfig {
  const raw: unknown = parse(stringify(viewsConfigToYaml(cfg)));
  return validateViews(raw);
}

describe('views save and reload', () => {
  it('keeps every optional field of the view and of every widget type', () => {
    const view: FullySpecified<ViewSpec> = {
      id: 'everything',
      name: 'Everything',
      icon: 'layout-grid',
      builtIn: true,
      rows: [{ widgets: Object.values(EVERY_FIELD) }],
    };
    const cfg: ViewsConfig = { views: [view] };
    expect(saveAndReload(cfg)).toStrictEqual(cfg);
  });

  it('adds nothing to widgets that set only their required fields', () => {
    const cfg = configOf(Object.values(REQUIRED_ONLY));
    expect(saveAndReload(cfg)).toStrictEqual(cfg);
  });

  it('keeps a table with every column deselected', () => {
    // The inspector's "Deselect all" stores [], which the table renders with
    // no columns. It must not reload as the default columns.
    const cfg = configOf([{ id: 't', type: 'table', size: 'full', enabledColumns: [] }]);
    expect(saveAndReload(cfg)).toStrictEqual(cfg);
  });

  it('writes a hidden pie legend to the YAML, and nothing for a default one', () => {
    expect(stringify(widgetToYaml({ id: 'p', type: 'pie', size: 'medium', groupBy: service, showLegend: false })))
      .toBe('id: p\ntype: pie\nsize: medium\ngroupBy: service\nshowLegend: false\n');
    expect(widgetToYaml(REQUIRED_ONLY.pie)).not.toHaveProperty('showLegend');
  });
});
