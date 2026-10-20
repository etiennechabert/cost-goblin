import { describe, expect, it } from 'vitest';
import { asDimensionId } from '@costgoblin/core/browser';
import type { DimensionId, ViewSpec, WidgetSpec } from '@costgoblin/core/browser';
import { enabledGroupBys, withEnabledGroupBys } from '../widgets/enabled-group-by.js';

const ids = (...names: string[]): DimensionId[] => names.map(asDimensionId);

function view(...rows: (readonly WidgetSpec[])[]): ViewSpec {
  return { id: 'v', name: 'View', rows: rows.map(widgets => ({ widgets })) };
}

function pie(id: string, groupBy: string): WidgetSpec {
  return { id, type: 'pie', size: 'medium', groupBy: asDimensionId(groupBy) };
}

function groupBys(spec: ViewSpec): string[] {
  return spec.rows.flatMap(row => row.widgets.map(w => ('groupBy' in w ? String(w.groupBy) : '-')));
}

// The Cost Overview's layout, with Account disabled.
const OVERVIEW = view(
  [{ id: 'sum', type: 'summary', size: 'small', metric: 'total' }, { id: 'bars', type: 'stackedBar', size: 'large', groupBy: asDimensionId('service') }],
  [pie('acc', 'account'), pie('reg', 'region'), pie('svc', 'service')],
  [{ id: 'tbl', type: 'table', size: 'full' }],
);
const ENABLED_WITHOUT_ACCOUNT = ids('region', 'service', 'service_category', 'sku_meter', 'resource_id', 'tag_stage');

describe('withEnabledGroupBys', () => {
  it('returns the spec itself when every group-by is enabled', () => {
    const spec = view([pie('a', 'service'), pie('b', 'region')]);
    expect(withEnabledGroupBys(spec, ids('region', 'service'))).toBe(spec);
  });

  it('returns the spec itself before the dimensions load', () => {
    expect(withEnabledGroupBys(OVERVIEW, [])).toBe(OVERVIEW);
  });

  it('moves a disabled group-by to the first enabled dimension the view does not show', () => {
    const out = withEnabledGroupBys(OVERVIEW, ENABLED_WITHOUT_ACCOUNT);
    expect(groupBys(out)).toEqual(['-', 'service', 'service_category', 'region', 'service', '-']);
  });

  it('treats a dimension that is no longer configured like a disabled one', () => {
    const out = withEnabledGroupBys(view([pie('a', 'tag_aws_cloudformation_stack_name'), pie('b', 'service')]), ids('service', 'region'));
    expect(groupBys(out)).toEqual(['region', 'service']);
  });

  it('gives two disabled widgets different dimensions', () => {
    const out = withEnabledGroupBys(view([pie('a', 'account'), pie('b', 'operation'), pie('c', 'service')]), ids('service', 'region', 'sku_meter'));
    expect(groupBys(out)).toEqual(['region', 'sku_meter', 'service']);
  });

  it('falls back to the first enabled dimension when the view already shows them all', () => {
    const out = withEnabledGroupBys(view([pie('a', 'service'), pie('b', 'region'), pie('c', 'account')]), ids('service', 'region'));
    expect(groupBys(out)).toEqual(['service', 'region', 'service']);
  });

  it('keeps every other field of the widget, the row and the view', () => {
    const spec: ViewSpec = {
      id: 'v',
      name: 'View',
      description: 'what it answers',
      builtIn: true,
      rows: [{ widgets: [{ id: 'top', type: 'topNBar', size: 'large', title: 'Top accounts', groupBy: asDimensionId('account'), topN: 5 }] }],
    };
    expect(withEnabledGroupBys(spec, ids('service'))).toEqual({
      ...spec,
      rows: [{ widgets: [{ id: 'top', type: 'topNBar', size: 'large', title: 'Top accounts', groupBy: asDimensionId('service'), topN: 5 }] }],
    });
  });
});

describe('enabledGroupBys', () => {
  it('keeps the enabled group-bys and moves the others to dimensions not already shown', () => {
    expect(enabledGroupBys(ids('account', 'tag_product', 'service'), ids('service', 'region', 'sku_meter')))
      .toEqual(ids('region', 'sku_meter', 'service'));
  });

  it('keeps every group-by before the dimensions load', () => {
    expect(enabledGroupBys(ids('account', 'service'), [])).toEqual(ids('account', 'service'));
  });

  it('repeats the first enabled dimension once every one is shown', () => {
    expect(enabledGroupBys(ids('account', 'region', 'service'), ids('service', 'region'))).toEqual(ids('service', 'region', 'service'));
  });
});
