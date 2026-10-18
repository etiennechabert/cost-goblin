import { describe, expect, it } from 'vitest';
import { viewToYaml, viewsConfigToYaml, widgetToYaml } from '../config/views-serialize.js';
import { WIDGET_TYPES, validateViews } from '../config/views-validator.js';
import { asDimensionId } from '../types/branded.js';
import type { ViewSpec, ViewsConfig, WidgetSpec } from '../types/views.js';

const service = asDimensionId('service');
const region = asDimensionId('region');

/** One widget of every type, with every optional field set. */
const fullWidgets: readonly WidgetSpec[] = [
  { id: 'sum', type: 'summary', size: 'small', title: 'Total', metric: 'delta' },
  { id: 'pie', type: 'pie', size: 'medium', title: 'By service', groupBy: service },
  { id: 'bar', type: 'stackedBar', size: 'large', title: 'Daily', groupBy: region },
  { id: 'par', type: 'pareto', size: 'medium', title: 'Pareto', groupBy: service },
  { id: 'bub', type: 'bubble', size: 'large', title: 'Movers', groupBy: service, logScale: 'linear', deltaThreshold: 100, percentThreshold: 5 },
  { id: 'map', type: 'treemap', size: 'full', title: 'Tree', groupBy: service, drillTo: region },
  { id: 'lin', type: 'line', size: 'large', title: 'Trend', groupBy: service, topN: 5 },
  { id: 'top', type: 'topNBar', size: 'medium', title: 'Top', groupBy: region, topN: 10 },
  { id: 'hea', type: 'heatmap', size: 'full', title: 'Heat', groupBy: service, topN: 8 },
  { id: 'wat', type: 'waterfall', size: 'large', title: 'Drivers', groupBy: service, topN: 6 },
  { id: 'pv', type: 'priceVolume', size: 'large', title: 'Price/volume', groupBy: service, topN: 4 },
  { id: 'bur', type: 'burndown', size: 'large', title: 'Budget', budget: 12_000 },
  { id: 'tab', type: 'table', size: 'full', title: 'Rows', enabledColumns: ['cost', 'service'] },
  { id: 'bas', type: 'baseline', size: 'medium', title: 'Baselines', topN: 3 },
];

/** The same widgets with every optional field left out. */
const bareWidgets: readonly WidgetSpec[] = [
  { id: 'sum', type: 'summary', size: 'small' },
  { id: 'pie', type: 'pie', size: 'medium', groupBy: service },
  { id: 'bar', type: 'stackedBar', size: 'large', groupBy: region },
  { id: 'par', type: 'pareto', size: 'medium', groupBy: service },
  { id: 'bub', type: 'bubble', size: 'large', groupBy: service },
  { id: 'map', type: 'treemap', size: 'full', groupBy: service },
  { id: 'lin', type: 'line', size: 'large', groupBy: service },
  { id: 'top', type: 'topNBar', size: 'medium', groupBy: region },
  { id: 'hea', type: 'heatmap', size: 'full', groupBy: service },
  { id: 'wat', type: 'waterfall', size: 'large', groupBy: service },
  { id: 'pv', type: 'priceVolume', size: 'large', groupBy: service },
  { id: 'bur', type: 'burndown', size: 'large' },
  { id: 'tab', type: 'table', size: 'full' },
  { id: 'bas', type: 'baseline', size: 'medium' },
];

describe('widgetToYaml', () => {
  it('covers every widget type', () => {
    expect(fullWidgets.map(w => w.type).sort()).toEqual([...WIDGET_TYPES].sort());
    expect(bareWidgets.map(w => w.type)).toEqual(fullWidgets.map(w => w.type));
  });

  it('writes every optional field of each widget type', () => {
    expect(fullWidgets.map(widgetToYaml)).toStrictEqual([
      { id: 'sum', type: 'summary', size: 'small', title: 'Total', metric: 'delta' },
      { id: 'pie', type: 'pie', size: 'medium', title: 'By service', groupBy: 'service' },
      { id: 'bar', type: 'stackedBar', size: 'large', title: 'Daily', groupBy: 'region' },
      { id: 'par', type: 'pareto', size: 'medium', title: 'Pareto', groupBy: 'service' },
      { id: 'bub', type: 'bubble', size: 'large', title: 'Movers', groupBy: 'service', logScale: 'linear', deltaThreshold: 100, percentThreshold: 5 },
      { id: 'map', type: 'treemap', size: 'full', title: 'Tree', groupBy: 'service', drillTo: 'region' },
      { id: 'lin', type: 'line', size: 'large', title: 'Trend', groupBy: 'service', topN: 5 },
      { id: 'top', type: 'topNBar', size: 'medium', title: 'Top', groupBy: 'region', topN: 10 },
      { id: 'hea', type: 'heatmap', size: 'full', title: 'Heat', groupBy: 'service', topN: 8 },
      { id: 'wat', type: 'waterfall', size: 'large', title: 'Drivers', groupBy: 'service', topN: 6 },
      { id: 'pv', type: 'priceVolume', size: 'large', title: 'Price/volume', groupBy: 'service', topN: 4 },
      { id: 'bur', type: 'burndown', size: 'large', title: 'Budget', budget: 12_000 },
      { id: 'tab', type: 'table', size: 'full', title: 'Rows', enabledColumns: ['cost', 'service'] },
      { id: 'bas', type: 'baseline', size: 'medium', title: 'Baselines', topN: 3 },
    ]);
  });

  it('writes only the required fields of a bare widget', () => {
    expect(bareWidgets.map(widgetToYaml)).toStrictEqual([
      { id: 'sum', type: 'summary', size: 'small' },
      { id: 'pie', type: 'pie', size: 'medium', groupBy: 'service' },
      { id: 'bar', type: 'stackedBar', size: 'large', groupBy: 'region' },
      { id: 'par', type: 'pareto', size: 'medium', groupBy: 'service' },
      { id: 'bub', type: 'bubble', size: 'large', groupBy: 'service' },
      { id: 'map', type: 'treemap', size: 'full', groupBy: 'service' },
      { id: 'lin', type: 'line', size: 'large', groupBy: 'service' },
      { id: 'top', type: 'topNBar', size: 'medium', groupBy: 'region' },
      { id: 'hea', type: 'heatmap', size: 'full', groupBy: 'service' },
      { id: 'wat', type: 'waterfall', size: 'large', groupBy: 'service' },
      { id: 'pv', type: 'priceVolume', size: 'large', groupBy: 'service' },
      { id: 'bur', type: 'burndown', size: 'large' },
      { id: 'tab', type: 'table', size: 'full' },
      { id: 'bas', type: 'baseline', size: 'medium' },
    ]);
  });

  it('writes keys in a stable order', () => {
    const bubble = fullWidgets.find(w => w.type === 'bubble');
    if (bubble === undefined) throw new Error('expected a bubble widget');
    expect(Object.keys(widgetToYaml(bubble))).toEqual(['id', 'type', 'size', 'title', 'groupBy', 'logScale', 'deltaThreshold', 'percentThreshold']);
  });

  it('writes a numeric bubble scale and a lone threshold', () => {
    expect(widgetToYaml({ id: 'b', type: 'bubble', size: 'large', groupBy: service, logScale: 50, percentThreshold: 0 }))
      .toStrictEqual({ id: 'b', type: 'bubble', size: 'large', groupBy: 'service', logScale: 50, percentThreshold: 0 });
  });

  it('keeps an empty table column list, and copies a non-empty one', () => {
    // A table with every column hidden stays that way across save and reload.
    expect(widgetToYaml({ id: 't', type: 'table', size: 'full', enabledColumns: [] })).toStrictEqual({ id: 't', type: 'table', size: 'full', enabledColumns: [] });
    const columns = ['cost', 'region'];
    const yaml = widgetToYaml({ id: 't', type: 'table', size: 'full', enabledColumns: columns });
    expect(yaml['enabledColumns']).toStrictEqual(['cost', 'region']);
    expect(yaml['enabledColumns']).not.toBe(columns);
  });
});

describe('viewToYaml / viewsConfigToYaml', () => {
  const builtInView: ViewSpec = { id: 'overview', name: 'Overview', icon: 'layout-dashboard', builtIn: true, rows: [{ widgets: fullWidgets }] };
  const customView: ViewSpec = { id: 'mine', name: 'Mine', builtIn: false, rows: [{ widgets: bareWidgets.slice(0, 2) }, { widgets: [] }] };

  it('writes the icon and builtIn flag of a built-in view, in a stable key order', () => {
    const yaml = viewToYaml(builtInView);
    expect(Object.keys(yaml)).toEqual(['id', 'name', 'icon', 'builtIn', 'rows']);
    expect(yaml).toStrictEqual({
      id: 'overview',
      name: 'Overview',
      icon: 'layout-dashboard',
      builtIn: true,
      rows: [{ widgets: fullWidgets.map(widgetToYaml) }],
    });
  });

  it('leaves out the icon and a false builtIn flag, keeping every row', () => {
    expect(viewToYaml(customView)).toStrictEqual({
      id: 'mine',
      name: 'Mine',
      rows: [
        { widgets: [{ id: 'sum', type: 'summary', size: 'small' }, { id: 'pie', type: 'pie', size: 'medium', groupBy: 'service' }] },
        { widgets: [] },
      ],
    });
  });

  it('wraps the views in a { views } block, in order', () => {
    expect(viewsConfigToYaml({ views: [builtInView, customView] })).toStrictEqual({ views: [viewToYaml(builtInView), viewToYaml(customView)] });
    expect(viewsConfigToYaml({ views: [] })).toStrictEqual({ views: [] });
  });

  it('round-trips through validateViews unchanged', () => {
    const cfg: ViewsConfig = {
      views: [
        builtInView,
        { id: 'bare', name: 'Bare', rows: [{ widgets: bareWidgets }] },
      ],
    };
    expect(validateViews(viewsConfigToYaml(cfg))).toStrictEqual(cfg);
  });
});
