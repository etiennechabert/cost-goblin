import { describe, expect, it } from 'vitest';
import { RETIRED_SEED_VIEW_IDS } from '../config/retired-seed-views.js';
import { viewsConfigToYaml } from '../config/views-serialize.js';
import { validateViews, WIDGET_TYPES } from '../config/views-validator.js';
import { OVERVIEW_SEED_VIEW, SEED_VIEWS_CONFIG } from '../types/seed-views.js';
import type { WidgetSpec } from '../types/views.js';

// Dimensions every provider populates. GCP has no service_category, and a
// group-by on a dimension the workspace lacks fails the widget's query.
const UNIVERSAL_DIMENSIONS = new Set(['account', 'region', 'service']);

const seedWidgets: readonly WidgetSpec[] = SEED_VIEWS_CONFIG.views.flatMap(v => v.rows.flatMap(r => r.widgets));

describe('SEED_VIEWS_CONFIG', () => {
  it('round-trips through the YAML serializer and validator unchanged', () => {
    expect(validateViews(viewsConfigToYaml(SEED_VIEWS_CONFIG))).toEqual(SEED_VIEWS_CONFIG);
  });

  it('opens with the Cost Overview and marks every dashboard built-in', () => {
    expect(SEED_VIEWS_CONFIG.views[0]).toBe(OVERVIEW_SEED_VIEW);
    expect(SEED_VIEWS_CONFIG.views.every(v => v.builtIn === true)).toBe(true);
  });

  it('never reuses a retired seed id, which the migration would drop', () => {
    expect(SEED_VIEWS_CONFIG.views.filter(v => RETIRED_SEED_VIEW_IDS.has(v.id))).toEqual([]);
  });

  it('says what each dashboard beyond the overview answers', () => {
    const undescribed = SEED_VIEWS_CONFIG.views
      .filter(v => v !== OVERVIEW_SEED_VIEW && (v.description ?? '').trim() === '')
      .map(v => v.id);
    expect(undescribed).toEqual([]);
  });

  it('groups only by dimensions every provider populates', () => {
    const groupBys = seedWidgets.flatMap(w => ('groupBy' in w ? [String(w.groupBy)] : []));
    expect(groupBys.filter(d => !UNIVERSAL_DIMENSIONS.has(d))).toEqual([]);
  });

  it('shows every widget type except baseline, which ignores the dashboard filters', () => {
    const used = new Set(seedWidgets.map(w => w.type));
    expect(WIDGET_TYPES.filter(t => !used.has(t))).toEqual(['baseline']);
  });
});
