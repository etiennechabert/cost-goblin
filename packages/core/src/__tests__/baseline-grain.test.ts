import { describe, it, expect } from 'vitest';
import { resolveDiscoveryGrain } from '../baseline/grain.js';
import type { DimensionsConfig } from '../types/config.js';
import { asDimensionId } from '../types/branded.js';

const DIMS: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id' },
    { name: asDimensionId('region'), label: 'Region', field: 'region' },
    { name: asDimensionId('region_country'), label: 'Country', field: 'region', enabled: false },
    { name: asDimensionId('service'), label: 'AWS Service', field: 'service' },
    { name: asDimensionId('service_family'), label: 'Service Category', field: 'service_family' },
    { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id' },
    { name: asDimensionId('usage_type'), label: 'Usage Type', field: 'usage_type', enabled: false },
  ],
  tags: [{ tagName: 'team', label: 'Team' }],
};

const CARD = { account_id: 50, region: 20, service: 120, service_family: 15, resource_id: 80_000 };

describe('resolveDiscoveryGrain', () => {
  it('auto: enabled built-ins minus high-cardinality, never tags', () => {
    const grain = resolveDiscoveryGrain({
      dimensions: DIMS,
      cardinalityByColumn: CARD,
      lineItems: 1_000_000,
      bytesPerRow: 16,
      override: [],
    });
    expect(grain.map((d) => d.name)).toEqual(['account', 'region', 'service', 'service_family']);
  });

  it('honors an explicit override of built-in ids', () => {
    const grain = resolveDiscoveryGrain({
      dimensions: DIMS,
      cardinalityByColumn: CARD,
      lineItems: 1_000_000,
      bytesPerRow: 16,
      override: [asDimensionId('service'), asDimensionId('account')],
    });
    expect(grain.map((d) => d.name)).toEqual(['account', 'service']);
  });

  it('collapses dimensions that share a physical column', () => {
    const dims: DimensionsConfig = {
      builtIn: [
        { name: asDimensionId('region'), label: 'Region', field: 'region' },
        { name: asDimensionId('region_country'), label: 'Country', field: 'region' },
      ],
      tags: [],
    };
    const grain = resolveDiscoveryGrain({
      dimensions: dims,
      cardinalityByColumn: { region: 20 },
      lineItems: 1000,
      bytesPerRow: 16,
      override: [],
    });
    expect(grain).toHaveLength(1);
    expect(grain[0]?.field).toBe('region');
  });
});
