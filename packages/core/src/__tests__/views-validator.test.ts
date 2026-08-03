import { describe, it, expect } from 'vitest';
import { validateViews } from '../config/views-validator.js';
import { ConfigValidationError } from '../config/validator.js';

describe('validateViews', () => {
  it('parses a valid views config', () => {
    const cfg = validateViews({
      views: [
        {
          id: 'overview',
          name: 'Cost Overview',
          builtIn: true,
          rows: [
            {
              widgets: [
                { id: 'w1', type: 'summary', size: 'small', metric: 'total' },
                { id: 'w2', type: 'pie', size: 'medium', groupBy: 'account' },
                { id: 'w3', type: 'pie', size: 'medium', groupBy: 'service' },
              ],
            },
            {
              widgets: [
                {
                  id: 'w4',
                  type: 'table',
                  size: 'full',
                  enabledColumns: ['cost', 'resource_id', 'description'],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(cfg.views).toHaveLength(1);
    const v = cfg.views[0];
    expect(v?.name).toBe('Cost Overview');
    expect(v?.builtIn).toBe(true);
    expect(v?.rows).toHaveLength(2);
  });

  it('migrates CUR-era dimension ids in persisted views (groupBy, drillTo, enabledColumns)', () => {
    const cfg = validateViews({
      views: [
        {
          id: 'legacy',
          name: 'Legacy',
          rows: [
            {
              widgets: [
                { id: 'w1', type: 'pie', size: 'medium', groupBy: 'service_family' },
                { id: 'w2', type: 'topNBar', size: 'medium', groupBy: 'line_item_type', topN: 5 },
                { id: 'w3', type: 'treemap', size: 'medium', groupBy: 'usage_type', drillTo: 'service_family' },
                { id: 'w4', type: 'table', size: 'full', enabledColumns: ['cost', 'usage_type', 'line_item_type'] },
              ],
            },
          ],
        },
      ],
    });
    const widgets = cfg.views[0]?.rows[0]?.widgets ?? [];
    expect(widgets[0]).toMatchObject({ groupBy: 'service_category' });
    expect(widgets[1]).toMatchObject({ groupBy: 'charge_category' });
    expect(widgets[2]).toMatchObject({ groupBy: 'sku_meter', drillTo: 'service_category' });
    expect(widgets[3]).toMatchObject({ enabledColumns: ['cost', 'sku_meter', 'charge_category'] });
  });

  it('rejects an unknown widget type', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'mystery', size: 'small' },
        ] }],
      }],
    })).toThrow(ConfigValidationError);
  });

  it('accepts a baseline widget (optional topN)', () => {
    const cfg = validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w1', type: 'baseline', size: 'medium' },
          { id: 'w2', type: 'baseline', size: 'small', topN: 5 },
        ] }],
      }],
    });
    const widgets = cfg.views[0]?.rows[0]?.widgets;
    expect(widgets?.[0]?.type).toBe('baseline');
    expect(widgets?.[1]).toMatchObject({ type: 'baseline', topN: 5 });
  });

  it('rejects a missing groupBy on a chart widget', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'pie', size: 'small' },
        ] }],
      }],
    })).toThrow(ConfigValidationError);
  });

  it('rejects an invalid widget size', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'summary', size: 'jumbo' },
        ] }],
      }],
    })).toThrow(ConfigValidationError);
  });

  it('rejects duplicate widget ids within a view', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [
          { widgets: [{ id: 'dup', type: 'summary', size: 'small' }] },
          { widgets: [{ id: 'dup', type: 'summary', size: 'small' }] },
        ],
      }],
    })).toThrow(/duplicate widget id/);
  });

  it('rejects duplicate view ids', () => {
    expect(() => validateViews({
      views: [
        { id: 'same', name: 'A', rows: [{ widgets: [{ id: 'w1', type: 'summary', size: 'small' }] }] },
        { id: 'same', name: 'B', rows: [{ widgets: [{ id: 'w2', type: 'summary', size: 'small' }] }] },
      ],
    })).toThrow(/duplicate view id/);
  });

  it('rejects views payload with no views key', () => {
    expect(() => validateViews({})).toThrow(ConfigValidationError);
  });

  it('rejects non-string entries in table enabledColumns', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'table', size: 'full', enabledColumns: [42] },
        ] }],
      }],
    })).toThrow(ConfigValidationError);
  });
});
