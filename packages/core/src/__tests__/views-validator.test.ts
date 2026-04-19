import { describe, it, expect } from 'vitest';
import { validateViews } from '../config/views-validator.js';
import { ConfigValidationError } from '../config/validator.js';
import { asDimensionId } from '../types/branded.js';

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
                { id: 'w3', type: 'pie', size: 'medium', groupBy: 'service', drillable: true },
              ],
            },
            {
              widgets: [
                {
                  id: 'w4',
                  type: 'table',
                  size: 'full',
                  groupBy: 'account',
                  columns: ['entity', 'service', 'cost', 'percentage'],
                  topN: 20,
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

  it('rejects an unknown widget type', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'mystery', size: 'small' },
        ] }],
      }],
    })).toThrow(ConfigValidationError);
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

  it('parses widget filter overlay', () => {
    const cfg = validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'pie', size: 'medium', groupBy: 'service', filters: { account: '111111111111' } },
        ] }],
      }],
    });
    const w = cfg.views[0]?.rows[0]?.widgets[0];
    expect(w?.filters).toBeDefined();
    if (w?.type === 'pie') {
      const accountDim = asDimensionId('account');
      expect(w.filters?.[accountDim]).toBe('111111111111');
    }
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

  it('rejects an invalid table column', () => {
    expect(() => validateViews({
      views: [{
        id: 'v', name: 'V', rows: [{ widgets: [
          { id: 'w', type: 'table', size: 'full', groupBy: 'account', columns: ['entity', 'gibberish'] },
        ] }],
      }],
    })).toThrow(ConfigValidationError);
  });
});
