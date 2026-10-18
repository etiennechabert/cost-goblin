import { describe, it, expect } from 'vitest';
import { asDimensionId } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import { mergeDefaultBuiltIns } from '../main/handlers/dimensions-merge.js';
import { PROVIDER_ABSENT_DIMENSIONS } from '../main/config-templates.js';

/** A GCP wizard writes dimensions.yaml WITHOUT service_category/operation/
 *  sku_meter because GCP's export cannot populate them. The default merge must
 *  respect that instead of silently resurrecting them (which produced a
 *  group-by that renders one blank value for 100% of spend). */
const GCP_WIZARD_DIMS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Project', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [],
};

const names = (d: DimensionsConfig): string[] => d.builtIn.map(b => String(b.name));

describe('mergeDefaultBuiltIns provider awareness', () => {
  it('does not re-add GCP-absent dims for a GCP-only workspace', () => {
    const merged = mergeDefaultBuiltIns(GCP_WIZARD_DIMS, ['gcp']);
    for (const absent of PROVIDER_ABSENT_DIMENSIONS.gcp) {
      expect(names(merged), absent).not.toContain(absent);
    }
  });

  it('re-adds those dims for an AWS-only workspace (AWS can populate them)', () => {
    const merged = mergeDefaultBuiltIns(GCP_WIZARD_DIMS, ['aws']);
    expect(names(merged)).toContain('service_category');
    expect(names(merged)).toContain('operation');
    expect(names(merged)).toContain('sku_meter');
  });

  it('keeps the dims for a mixed AWS+GCP workspace — at least one provider fills them', () => {
    const merged = mergeDefaultBuiltIns(GCP_WIZARD_DIMS, ['aws', 'gcp']);
    expect(names(merged)).toContain('service_category');
  });

  it('imposes no restriction when no providers are configured (fresh install)', () => {
    const merged = mergeDefaultBuiltIns(GCP_WIZARD_DIMS, []);
    expect(names(merged)).toContain('service_category');
  });

  it('never drops a dimension the config already carries, even if provider-absent', () => {
    const withServiceCategory: DimensionsConfig = {
      builtIn: [
        ...GCP_WIZARD_DIMS.builtIn,
        { name: asDimensionId('service_category'), label: 'Service Category', field: 'service_category' },
      ],
      tags: [],
    };
    const merged = mergeDefaultBuiltIns(withServiceCategory, ['gcp']);
    expect(names(merged)).toContain('service_category');
  });
});

describe('mergeDefaultBuiltIns backfills', () => {
  it('renames a stale default label, keeps user labels and descriptions, and carries the order', () => {
    const dims: DimensionsConfig = {
      builtIn: [
        { name: asDimensionId('service'), label: 'AWS Service', field: 'service' },
        { name: asDimensionId('account'), label: 'My Accounts', field: 'account_id', description: 'Mine.' },
        { name: asDimensionId('custom_meter'), label: 'Custom', field: 'operation' },
      ],
      tags: [],
      order: ['builtin:service', 'builtin:account'],
    };
    const merged = mergeDefaultBuiltIns(dims, []);
    const byName = new Map(merged.builtIn.map(d => [String(d.name), d]));
    expect(byName.get('service')?.label).toBe('Service');
    expect(byName.get('service')?.description).toMatch(/FOCUS ServiceName/);
    expect(byName.get('account')).toMatchObject({ label: 'My Accounts', description: 'Mine.' });
    // No default to borrow a description from.
    expect(byName.get('custom_meter')?.description).toBeUndefined();
    expect(merged.order).toEqual(['builtin:service', 'builtin:account']);
  });

  it('returns the loaded config itself when nothing is missing or stale', () => {
    const complete = mergeDefaultBuiltIns(GCP_WIZARD_DIMS, []);
    expect(mergeDefaultBuiltIns(complete, [])).toBe(complete);
    expect(complete.order).toBeUndefined();
  });
});
