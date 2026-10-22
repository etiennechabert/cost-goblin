import { afterEach, describe, it, expect, vi } from 'vitest';
import { validateViews } from '../config/views-validator.js';
import { ConfigValidationError } from '../config/validator.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadViews } from '../config/loader.js';
import { logger } from '../logger/logger.js';

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

  it('moves widgets on the retired Country and Continent dimensions to Region', () => {
    const cfg = validateViews({
      views: [{
        id: 'geo',
        name: 'Geo',
        rows: [{
          widgets: [
            { id: 'w1', type: 'pie', size: 'medium', groupBy: 'region_country' },
            { id: 'w2', type: 'treemap', size: 'medium', groupBy: 'region_continent', drillTo: 'region_country' },
            { id: 'w3', type: 'table', size: 'full', enabledColumns: ['cost', 'region_continent'] },
          ],
        }],
      }],
    });
    const widgets = cfg.views[0]?.rows[0]?.widgets ?? [];
    expect(widgets[0]).toMatchObject({ groupBy: 'region' });
    expect(widgets[1]).toMatchObject({ groupBy: 'region', drillTo: 'region' });
    expect(widgets[2]).toMatchObject({ enabledColumns: ['cost', 'region'] });
  });

  it('migrates CUR-era tag_user_* dimension ids (the validator strips user_ from tagNames)', () => {
    const cfg = validateViews({
      views: [{
        id: 'legacy-tags',
        name: 'Legacy tags',
        rows: [{
          widgets: [
            { id: 'w1', type: 'pie', size: 'medium', groupBy: 'tag_user_team' },
            { id: 'w2', type: 'table', size: 'full', enabledColumns: ['cost', 'tag_user_environment'] },
          ],
        }],
      }],
    });
    const widgets = cfg.views[0]?.rows[0]?.widgets ?? [];
    expect(widgets[0]).toMatchObject({ groupBy: 'tag_team' });
    expect(widgets[1]).toMatchObject({ enabledColumns: ['cost', 'tag_environment'] });
  });

  it('parses an optional view description', () => {
    const cfg = validateViews({
      views: [
        { id: 'a', name: 'A', description: 'What this answers', rows: [] },
        { id: 'b', name: 'B', rows: [] },
        { id: 'c', name: 'C', description: '  ', rows: [] },
      ],
    });
    expect(cfg.views[0]?.description).toBe('What this answers');
    expect(cfg.views[1]).not.toHaveProperty('description');
    // Blank reads as absent, so the header falls back to its tagline.
    expect(cfg.views[2]).not.toHaveProperty('description');
  });

  // Failing the load would let views:get-config reseed the file and drop the
  // user's dashboards over a subtitle. A bare `description:` parses as null.
  it('loads a null or non-string view description as absent', () => {
    const cfg = validateViews({
      views: [
        { id: 'a', name: 'A', description: null, rows: [] },
        { id: 'b', name: 'B', description: 42, rows: [] },
      ],
    });
    expect(cfg.views[0]).not.toHaveProperty('description');
    expect(cfg.views[1]).not.toHaveProperty('description');
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

  it.each([false, true])('keeps a pie widget\'s showLegend: %s', (showLegend) => {
    const cfg = validateViews({
      views: [{ id: 'v', name: 'V', rows: [{ widgets: [
        { id: 'p', type: 'pie', size: 'medium', groupBy: 'service', showLegend },
      ] }] }],
    });
    expect(cfg.views[0]?.rows[0]?.widgets[0]).toEqual({ id: 'p', type: 'pie', size: 'medium', groupBy: 'service', showLegend });
  });

  it('ignores a non-boolean showLegend instead of failing the views load', () => {
    const cfg = validateViews({
      views: [{ id: 'v', name: 'V', rows: [{ widgets: [
        { id: 'p', type: 'pie', size: 'medium', groupBy: 'service', showLegend: 'false' },
      ] }] }],
    });
    expect(cfg.views[0]?.rows[0]?.widgets[0]).toStrictEqual({ id: 'p', type: 'pie', size: 'medium', groupBy: 'service' });
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

describe('validateViews: live dimension ids gate the CUR-era renames', () => {
  it('preserves live tag_user_* ids in groupBy, drillTo and enabledColumns', () => {
    // A FOCUS-era tag key like `user:CostCenter` sanitizes to the dimension
    // id `tag_user_CostCenter` — the rename must not corrupt it on save.
    const live = new Set(['tag_user_CostCenter', 'service']);
    const cfg = validateViews({
      views: [{
        id: 'live-tags',
        name: 'Live tags',
        rows: [{
          widgets: [
            { id: 'w1', type: 'pie', size: 'medium', groupBy: 'tag_user_CostCenter' },
            { id: 'w2', type: 'treemap', size: 'medium', groupBy: 'service', drillTo: 'tag_user_CostCenter' },
            { id: 'w3', type: 'table', size: 'full', enabledColumns: ['cost', 'tag_user_CostCenter', 'tag_user_team'] },
          ],
        }],
      }],
    }, live);
    const widgets = cfg.views[0]?.rows[0]?.widgets ?? [];
    expect(widgets[0]).toMatchObject({ groupBy: 'tag_user_CostCenter' });
    expect(widgets[1]).toMatchObject({ drillTo: 'tag_user_CostCenter' });
    // tag_user_team is NOT live → still treated as a CUR-era leftover.
    expect(widgets[2]).toMatchObject({ enabledColumns: ['cost', 'tag_user_CostCenter', 'tag_team'] });
  });
});

describe('validateViews: topN must be a positive integer', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // The five ranked charts and the baseline list: every widget with a Top N.
  const TOP_N_TYPES = ['line', 'topNBar', 'heatmap', 'waterfall', 'priceVolume', 'baseline'] as const;
  // 0 draws an empty "Top 0", a negative drops the last entries (slice(0, -3))
  // and a fraction is truncated. YAML's .nan and .inf parse as numbers too.
  const UNUSABLE = [0, -3, 2.5, Number.NaN, Number.POSITIVE_INFINITY];
  const W = 'views[0].rows[0].widgets[0]';

  function widgetOf(type: (typeof TOP_N_TYPES)[number], topN?: unknown): Record<string, unknown> {
    return {
      id: 'w', type, size: 'medium',
      ...(type === 'baseline' ? {} : { groupBy: 'service' }),
      ...(topN === undefined ? {} : { topN }),
    };
  }

  function viewsOf(widget: Record<string, unknown>): unknown {
    return { views: [{ id: 'v', name: 'V', rows: [{ widgets: [widget] }] }] };
  }

  describe.each(TOP_N_TYPES)('%s widget', (type) => {
    it('keeps a positive integer, in both modes', () => {
      const warn = vi.spyOn(logger, 'warn');
      for (const options of [{}, { invalidTopN: 'drop' }] as const) {
        expect(validateViews(viewsOf(widgetOf(type, 5)), undefined, options).views[0]?.rows[0]?.widgets[0])
          .toStrictEqual(widgetOf(type, 5));
      }
      expect(warn).not.toHaveBeenCalled();
    });

    it.each(UNUSABLE)('rejects topN %s, naming the widget', (topN) => {
      const validate = (): unknown => validateViews(viewsOf(widgetOf(type, topN)));
      expect(validate).toThrow(ConfigValidationError);
      expect(validate).toThrow(`${W}.topN must be a positive integer (got ${String(topN)})`);
    });

    it.each(UNUSABLE)('drops topN %s with a warning when loading', (topN) => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      const cfg = validateViews(viewsOf(widgetOf(type, topN)), undefined, { invalidTopN: 'drop' });
      expect(cfg.views[0]?.rows[0]?.widgets[0]).toStrictEqual(widgetOf(type));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain(`${W}.topN must be a positive integer (got ${String(topN)})`);
    });
  });

  it('refuses a non-numeric topN in both modes, as before', () => {
    for (const options of [{}, { invalidTopN: 'drop' }] as const) {
      expect(() => validateViews(viewsOf(widgetOf('topNBar', '5')), undefined, options))
        .toThrow(`${W}.topN must be a number`);
    }
  });
});

describe('loadViews', () => {
  let dir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  // Earlier builds accepted any number, so a views.yaml on disk can hold one.
  // Failing the load would take every dashboard down over one widget setting.
  it('loads a views.yaml whose topN is not a positive integer, without that value', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    dir = await mkdtemp(join(tmpdir(), 'cg-views-'));
    const path = join(dir, 'views.yaml');
    await writeFile(path, [
      'views:',
      '  - id: custom',
      '    name: Custom',
      '    rows:',
      '      - widgets:',
      '          - { id: bars, type: topNBar, size: medium, groupBy: service, topN: 0 }',
      '          - { id: lines, type: line, size: large, groupBy: account, topN: 2.5 }',
      '          - { id: heat, type: heatmap, size: full, groupBy: region, topN: .nan }',
      '          - { id: savings, type: baseline, size: small, topN: -3 }',
      '          - { id: drivers, type: waterfall, size: large, groupBy: service, topN: 5 }',
      '',
    ].join('\n'));
    const cfg = await loadViews(path);
    expect(cfg.views[0]?.rows[0]?.widgets).toStrictEqual([
      { id: 'bars', type: 'topNBar', size: 'medium', groupBy: 'service' },
      { id: 'lines', type: 'line', size: 'large', groupBy: 'account' },
      { id: 'heat', type: 'heatmap', size: 'full', groupBy: 'region' },
      { id: 'savings', type: 'baseline', size: 'small' },
      { id: 'drivers', type: 'waterfall', size: 'large', groupBy: 'service', topN: 5 },
    ]);
  });
});
