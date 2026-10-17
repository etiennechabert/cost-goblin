import { describe, expect, it } from 'vitest';
import { WIDGET_TYPES, validateViews } from '../config/views-validator.js';
import { ConfigValidationError } from '../config/validator.js';
import type { ViewSpec, WidgetSpec } from '../types/views.js';

const W = 'views[0].rows[0].widgets[0]';

function viewsWith(widgets: readonly unknown[], view: Readonly<Record<string, unknown>> = {}): unknown {
  return { views: [{ id: 'v', name: 'V', rows: [{ widgets }], ...view }] };
}

function onlyView(raw: unknown): ViewSpec {
  const view = validateViews(raw).views[0];
  if (view === undefined) throw new Error('expected one view');
  return view;
}

function onlyWidget(raw: unknown): WidgetSpec {
  const widget = onlyView(viewsWith([raw])).rows[0]?.widgets[0];
  if (widget === undefined) throw new Error('expected one widget');
  return widget;
}

/** The message of the ConfigValidationError `fn` throws; anything else fails the test. */
function configError(fn: () => unknown): string {
  try {
    fn();
  } catch (err: unknown) {
    if (err instanceof ConfigValidationError) return err.message;
    throw err;
  }
  throw new Error('expected a ConfigValidationError, but nothing was thrown');
}

function widgetError(raw: unknown): string {
  return configError(() => validateViews(viewsWith([raw])));
}

describe('validateViews: widget base fields', () => {
  it('keeps a widget title', () => {
    expect(onlyWidget({ id: 'w', type: 'summary', size: 'small', title: 'Spend' }))
      .toStrictEqual({ type: 'summary', id: 'w', size: 'small', title: 'Spend' });
  });

  it('omits the title key when the widget has none', () => {
    expect(onlyWidget({ id: 'w', type: 'summary', size: 'small' })).toStrictEqual({ type: 'summary', id: 'w', size: 'small' });
  });

  it.each([
    ['a non-string title', { id: 'w', type: 'summary', size: 'small', title: 3 }, `${W}.title must be a string`],
    ['no id', { type: 'summary', size: 'small' }, `${W}.id must be a string`],
    ['a non-string type', { id: 'w', type: 1, size: 'small' }, `${W}.type must be a string`],
    ['no size', { id: 'w', type: 'summary' }, `${W}.size must be a string`],
    ['an unknown size', { id: 'w', type: 'summary', size: 'jumbo' }, `${W}.size must be one of: small, medium, large, full (got jumbo)`],
    ['a non-object shape', 'summary', `${W} must be an object`],
  ])('rejects a widget with %s', (_label, raw, message) => {
    expect(widgetError(raw)).toBe(message);
  });

  it('names every widget type when the type is unknown', () => {
    expect(widgetError({ id: 'w', type: 'mystery', size: 'small' }))
      .toBe(`${W}.type must be one of: ${WIDGET_TYPES.join(', ')} (got mystery)`);
  });

  it('accepts one widget of every type', () => {
    const widgets = WIDGET_TYPES.map((type, i) => ({ id: `w${String(i)}`, type, size: 'medium', groupBy: 'service' }));
    const view = onlyView(viewsWith(widgets));
    expect(view.rows[0]?.widgets.map(w => w.type)).toEqual([...WIDGET_TYPES]);
  });
});

describe('validateViews: summary widgets', () => {
  it.each(['total', 'delta', 'topEntity', 'entityCount'])('keeps the %s metric', (metric) => {
    expect(onlyWidget({ id: 'w', type: 'summary', size: 'small', metric }))
      .toStrictEqual({ type: 'summary', id: 'w', size: 'small', metric });
  });

  it('rejects an unknown metric, listing the valid ones', () => {
    expect(widgetError({ id: 'w', type: 'summary', size: 'small', metric: 'median' }))
      .toBe(`${W}.metric must be one of: total, delta, topEntity, entityCount`);
  });

  it('rejects a non-string metric', () => {
    expect(widgetError({ id: 'w', type: 'summary', size: 'small', metric: 1 })).toBe(`${W}.metric must be a string`);
  });
});

describe('validateViews: bubble widgets', () => {
  const bubble = { id: 'b', type: 'bubble', size: 'large', groupBy: 'service' };

  it('keeps a linear scale', () => {
    expect(onlyWidget({ ...bubble, logScale: 'linear' }))
      .toStrictEqual({ type: 'bubble', id: 'b', size: 'large', groupBy: 'service', logScale: 'linear' });
  });

  it('keeps a numeric symlog constant and both thresholds', () => {
    expect(onlyWidget({ ...bubble, logScale: 100, deltaThreshold: 50, percentThreshold: 0 }))
      .toStrictEqual({ type: 'bubble', id: 'b', size: 'large', groupBy: 'service', logScale: 100, deltaThreshold: 50, percentThreshold: 0 });
  });

  it('omits every optional key of a bare bubble', () => {
    expect(onlyWidget(bubble)).toStrictEqual({ type: 'bubble', id: 'b', size: 'large', groupBy: 'service' });
  });

  it.each([['a string other than linear', 'log'], ['a boolean', true], ['null', null]])('rejects a logScale that is %s', (_label, logScale) => {
    expect(widgetError({ ...bubble, logScale })).toBe(`${W}.logScale must be a number or 'linear'`);
  });

  it('rejects non-numeric thresholds', () => {
    expect(widgetError({ ...bubble, deltaThreshold: '50' })).toBe(`${W}.deltaThreshold must be a number`);
    expect(widgetError({ ...bubble, percentThreshold: null })).toBe(`${W}.percentThreshold must be a number`);
  });

  it('migrates a CUR-era group-by id', () => {
    expect(onlyWidget({ ...bubble, groupBy: 'usage_type' })).toMatchObject({ type: 'bubble', groupBy: 'sku_meter' });
  });
});

describe('validateViews: treemap widgets', () => {
  it('omits drillTo when the treemap has none', () => {
    expect(onlyWidget({ id: 't', type: 'treemap', size: 'full', groupBy: 'account' }))
      .toStrictEqual({ type: 'treemap', id: 't', size: 'full', groupBy: 'account' });
  });

  it('keeps a drillTo dimension', () => {
    expect(onlyWidget({ id: 't', type: 'treemap', size: 'full', groupBy: 'account', drillTo: 'service' }))
      .toStrictEqual({ type: 'treemap', id: 't', size: 'full', groupBy: 'account', drillTo: 'service' });
  });

  it('rejects a non-string drillTo', () => {
    expect(widgetError({ id: 't', type: 'treemap', size: 'full', groupBy: 'account', drillTo: ['service'] }))
      .toBe(`${W}.drillTo must be a string`);
  });
});

describe('validateViews: group-by widgets', () => {
  it.each(['pie', 'stackedBar', 'pareto'])('reads the %s widget group-by dimension', (type) => {
    expect(onlyWidget({ id: 'g', type, size: 'medium', groupBy: 'region' }))
      .toStrictEqual({ type, id: 'g', size: 'medium', groupBy: 'region' });
  });

  it.each(['pie', 'bubble', 'treemap'])('rejects a %s widget with no group-by dimension', (type) => {
    expect(widgetError({ id: 'g', type, size: 'medium' })).toBe(`${W}.groupBy must be a string`);
  });
});

describe('validateViews: top-N widgets', () => {
  const topNTypes = ['line', 'topNBar', 'heatmap', 'waterfall', 'priceVolume'];

  it.each(topNTypes)('keeps the topN of a %s widget', (type) => {
    expect(onlyWidget({ id: 'n', type, size: 'large', groupBy: 'service', topN: 5 }))
      .toStrictEqual({ type, id: 'n', size: 'large', groupBy: 'service', topN: 5 });
  });

  it.each(topNTypes)('omits topN when a %s widget has none', (type) => {
    expect(onlyWidget({ id: 'n', type, size: 'large', groupBy: 'service' }))
      .toStrictEqual({ type, id: 'n', size: 'large', groupBy: 'service' });
  });

  it('migrates a CUR-era group-by id', () => {
    expect(onlyWidget({ id: 'n', type: 'heatmap', size: 'large', groupBy: 'service_family' })).toMatchObject({ groupBy: 'service_category' });
  });

  it('rejects a non-numeric topN', () => {
    expect(widgetError({ id: 'n', type: 'line', size: 'large', groupBy: 'service', topN: '5' })).toBe(`${W}.topN must be a number`);
  });

  it('rejects a top-N widget with no group-by dimension', () => {
    expect(widgetError({ id: 'n', type: 'waterfall', size: 'large' })).toBe(`${W}.groupBy must be a string`);
  });
});

describe('validateViews: burndown, baseline and table widgets', () => {
  it('keeps a burndown budget', () => {
    expect(onlyWidget({ id: 'd', type: 'burndown', size: 'large', budget: 12_000 }))
      .toStrictEqual({ type: 'burndown', id: 'd', size: 'large', budget: 12_000 });
  });

  it('omits the budget when a burndown has none', () => {
    expect(onlyWidget({ id: 'd', type: 'burndown', size: 'large' })).toStrictEqual({ type: 'burndown', id: 'd', size: 'large' });
  });

  it('rejects a non-numeric burndown budget', () => {
    expect(widgetError({ id: 'd', type: 'burndown', size: 'large', budget: '12000' })).toBe(`${W}.budget must be a number`);
  });

  it('rejects a non-numeric baseline topN', () => {
    expect(widgetError({ id: 'bl', type: 'baseline', size: 'medium', topN: false })).toBe(`${W}.topN must be a number`);
  });

  it('omits enabledColumns when a table has none', () => {
    expect(onlyWidget({ id: 'tb', type: 'table', size: 'full' })).toStrictEqual({ type: 'table', id: 'tb', size: 'full' });
  });

  it('rejects table columns that are not an array of strings', () => {
    expect(widgetError({ id: 'tb', type: 'table', size: 'full', enabledColumns: 'cost' })).toBe(`${W}.enabledColumns must be an array`);
    expect(widgetError({ id: 'tb', type: 'table', size: 'full', enabledColumns: ['cost', 42] })).toBe(`${W}.enabledColumns[1] must be a string`);
  });
});

describe('validateViews: views and rows', () => {
  const summary = { id: 'w', type: 'summary', size: 'small' };

  it('keeps a view icon', () => {
    expect(onlyView(viewsWith([summary], { icon: 'chart-pie' })).icon).toBe('chart-pie');
  });

  it('omits the icon and builtIn keys of a plain view', () => {
    const view = onlyView(viewsWith([summary]));
    expect(view).not.toHaveProperty('icon');
    expect(view).not.toHaveProperty('builtIn');
  });

  it('marks a view built-in only when builtIn is exactly true', () => {
    expect(onlyView(viewsWith([summary], { builtIn: true })).builtIn).toBe(true);
    expect(onlyView(viewsWith([summary], { builtIn: 'yes' }))).not.toHaveProperty('builtIn');
    expect(onlyView(viewsWith([summary], { builtIn: false }))).not.toHaveProperty('builtIn');
  });

  it('accepts a view with no rows', () => {
    expect(onlyView({ views: [{ id: 'empty', name: 'Empty', rows: [] }] })).toStrictEqual({ id: 'empty', name: 'Empty', rows: [] });
  });

  it.each([
    ['a non-string icon', viewsWith([summary], { icon: 7 }), 'views[0].icon must be a string'],
    ['no id', { views: [{ name: 'V', rows: [] }] }, 'views[0].id must be a string'],
    ['no name', { views: [{ id: 'v', rows: [] }] }, 'views[0].name must be a string'],
    ['no rows', { views: [{ id: 'v', name: 'V' }] }, 'views[0].rows must be an array'],
    ['a non-object row', { views: [{ id: 'v', name: 'V', rows: ['row'] }] }, 'views[0].rows[0] must be an object'],
    ['a row without a widget list', { views: [{ id: 'v', name: 'V', rows: [{}] }] }, 'views[0].rows[0].widgets must be an array'],
    ['a non-object view', { views: ['overview'] }, 'views[0] must be an object'],
  ])('rejects a view with %s', (_label, raw, message) => {
    expect(configError(() => validateViews(raw))).toBe(message);
  });

  it('names the duplicated widget id, across rows', () => {
    const raw = { views: [{ id: 'v', name: 'V', rows: [{ widgets: [{ ...summary, id: 'dup' }] }, { widgets: [{ ...summary, id: 'dup' }] }] }] };
    expect(configError(() => validateViews(raw))).toBe('views[0]: duplicate widget id "dup"');
  });

  it('names the duplicated view id', () => {
    const view = { id: 'same', name: 'A', rows: [] };
    expect(configError(() => validateViews({ views: [view, { ...view, name: 'B' }] }))).toBe('duplicate view id "same"');
  });

  it('allows the same widget id in two different views', () => {
    const cfg = validateViews({ views: [{ id: 'a', name: 'A', rows: [{ widgets: [summary] }] }, { id: 'b', name: 'B', rows: [{ widgets: [summary] }] }] });
    expect(cfg.views.map(v => v.rows[0]?.widgets[0]?.id)).toEqual(['w', 'w']);
  });

  it('rejects a payload that is not a { views: [...] } object', () => {
    expect(configError(() => validateViews([]))).toBe('views config must be an object');
    expect(configError(() => validateViews({ views: {} }))).toBe('views must be an array');
  });
});
