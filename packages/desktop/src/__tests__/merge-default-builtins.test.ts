import { describe, it, expect } from 'vitest';
import { asDimensionId } from '@costgoblin/core';
import type { DimensionsConfig } from '@costgoblin/core';
import { DEFAULT_BUILT_INS, mergeDefaultBuiltIns } from '../main/handlers/dimensions-merge.js';
import { PROVIDER_ABSENT_DIMENSIONS, type TemplateProviderType } from '../main/config-templates.js';

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

  // GCP fills Service Code with an opaque service id (one per service name),
  // and its export has no CommitmentDiscount* column at all.
  it('counts Service Code and Commitment Status among the dims GCP cannot fill', () => {
    const gcpOnly = names(mergeDefaultBuiltIns(GCP_WIZARD_DIMS, ['gcp']));
    expect(gcpOnly).not.toContain('service_code');
    expect(gcpOnly).not.toContain('commitment_status');
    expect(names(mergeDefaultBuiltIns(GCP_WIZARD_DIMS, ['aws']))).toEqual(
      expect.arrayContaining(['service_code', 'commitment_status']),
    );
  });

  it('drops a dimension the config already carries when no configured provider can fill it', () => {
    const carried: DimensionsConfig = {
      builtIn: [
        ...GCP_WIZARD_DIMS.builtIn,
        { name: asDimensionId('service_category'), label: 'Service Category', field: 'service_category' },
        { name: asDimensionId('service_code'), label: 'Service Code', field: 'service_code' },
        { name: asDimensionId('commitment_status'), label: 'Commitment Status', field: 'commitment_status', enabled: false },
      ],
      tags: [],
      order: ['builtin:service_code', 'builtin:account'],
    };
    const gcpOnly = mergeDefaultBuiltIns(carried, ['gcp']);
    expect(names(gcpOnly)).toEqual(['account', 'region', 'service', 'provider', 'charge_category', 'pricing_category', 'resource_id']);
    expect(gcpOnly.order).toEqual(carried.order);
    // One provider that can fill them is enough to keep them, enabled as they were.
    const mixed = mergeDefaultBuiltIns(carried, ['aws', 'gcp']);
    expect(mixed.builtIn.slice(3, 6).map(d => [String(d.name), d.enabled])).toEqual([
      ['service_category', undefined], ['service_code', undefined], ['commitment_status', false],
    ]);
    // Unknown providers (config not loadable yet) restrict nothing.
    expect(names(mergeDefaultBuiltIns(carried, []))).toContain('service_code');
  });
});

describe('mergeDefaultBuiltIns retired dimensions', () => {
  // Country and Continent regrouped the region column through the SSM
  // snapshot. Country split spend like Region; Continent held ISO 3166-2
  // subdivisions (IE-D, US-VA), so it was Region under other labels.
  const withRegionViews: DimensionsConfig = {
    builtIn: [
      { name: asDimensionId('region'), label: 'Region', field: 'region', useRegionNames: true },
      { name: asDimensionId('region_country'), label: 'Country', field: 'region' },
      { name: asDimensionId('region_continent'), label: 'Continent', field: 'region', enabled: false },
    ],
    tags: [],
  };

  it('drops Country and Continent from a config, enabled or not, whatever the providers', () => {
    const providerSets: readonly (readonly TemplateProviderType[])[] = [[], ['aws'], ['gcp'], ['aws', 'gcp']];
    for (const providers of providerSets) {
      const merged = names(mergeDefaultBuiltIns(withRegionViews, providers));
      expect(merged).toContain('region');
      expect(merged).not.toContain('region_country');
      expect(merged).not.toContain('region_continent');
    }
  });

  it('no longer ships them as defaults', () => {
    const defaults = DEFAULT_BUILT_INS.map(d => String(d.name));
    expect(defaults).not.toContain('region_country');
    expect(defaults).not.toContain('region_continent');
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

  it('rewrites a description that is still an old AWS-only default and keeps an edited one', () => {
    const dims: DimensionsConfig = {
      builtIn: [
        { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name', description: 'AWS account the cost was charged to. Main axis for org/team-level rollups.' },
        { name: asDimensionId('region'), label: 'Region', field: 'region', description: 'AWS region where the resource ran. Useful for spotting unintended multi-region sprawl.' },
        { name: asDimensionId('service'), label: 'Service', field: 'service', description: 'AWS service code (EC2, S3, RDS, etc.) — the broadest "what cost me this?" view.' },
        { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', description: 'AWS resource ID or ARN (i-0abc…, arn:aws:rds:…). High-cardinality — enable when investigating a specific resource.' },
        { name: asDimensionId('pricing_category'), label: 'Pricing Category', field: 'pricing_category', description: 'How the usage was priced — Standard (on-demand), Committed (RI/SP-covered), Dynamic (spot).' },
        { name: asDimensionId('service_code'), label: 'Service Code', field: 'service_code', description: 'Exact AWS service code (AmazonEC2, AmazonS3). Our own note.' },
      ],
      tags: [],
    };
    const merged = new Map(mergeDefaultBuiltIns(dims, []).builtIn.map(d => [String(d.name), d.description]));
    for (const name of ['account', 'region', 'service', 'resource_id', 'pricing_category']) {
      expect(merged.get(name), name).toBe(DEFAULT_BUILT_INS.find(d => d.name === name)?.description);
    }
    expect(merged.get('service_code')).toBe('Exact AWS service code (AmazonEC2, AmazonS3). Our own note.');
  });

  it('words the defaults GCP can fill for any provider, not for AWS alone', () => {
    const shownOnGcp = DEFAULT_BUILT_INS.filter(d => !PROVIDER_ABSENT_DIMENSIONS.gcp.has(String(d.name)));
    for (const d of shownOnGcp) {
      expect(d.description, String(d.name)).not.toMatch(/^AWS |Exact AWS|RI\/SP/);
    }
    expect(DEFAULT_BUILT_INS.find(d => d.name === 'account')?.description).toMatch(/GCP project/);
  });

  it('returns the loaded config itself when nothing is missing or stale', () => {
    const complete = mergeDefaultBuiltIns(GCP_WIZARD_DIMS, []);
    expect(mergeDefaultBuiltIns(complete, [])).toBe(complete);
    expect(complete.order).toBeUndefined();
  });
});
