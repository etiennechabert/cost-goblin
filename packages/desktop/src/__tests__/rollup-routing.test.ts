import { describe, it, expect } from 'vitest';
import { type DimensionsConfig, type ProviderSourceSpec, asDimensionId, asProviderName, tagSqlColumn } from '@costgoblin/core';
import { columnForDimension, providersEmptyForRange, resolveRollupSource } from '../main/handlers/query-utils.js';
import { RollupStore } from '../main/rollup-store.js';

const dims: DimensionsConfig = {
  builtIn: [
    { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name' },
    { name: asDimensionId('service'), label: 'Service', field: 'service' },
  ],
  tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }],
};

describe('columnForDimension', () => {
  it('maps a built-in id to its field and a tag id to its column', () => {
    expect(columnForDimension(dims, 'account')).toBe('account_id');
    expect(columnForDimension(dims, 'service')).toBe('service');
    expect(columnForDimension(dims, 'tag_team')).toBe(tagSqlColumn({ tagName: 'team' }));
  });
  it('maps tag ids that differ only by case to distinct columns', () => {
    const cased: DimensionsConfig = { builtIn: [], tags: [{ tagName: 'STAGE', label: 'STAGE' }, { tagName: 'stage', label: 'stage' }] };
    const upper = columnForDimension(cased, 'tag_STAGE');
    const lower = columnForDimension(cased, 'tag_stage');
    expect(upper.toLowerCase()).not.toBe(lower.toLowerCase());
  });
  it('returns an unknown/disabled id unchanged (so it gates out of the rollup grain)', () => {
    expect(columnForDimension(dims, 'resource_id')).toBe('resource_id');
  });
});

describe('resolveRollupSource', () => {
  const oneProvider: ProviderSourceSpec[] = [{ name: asProviderName('aws'), type: 'aws' }];
  it('returns undefined when the store has no valid partitions (falls back to raw)', () => {
    const store = new RollupStore({ dataDir: '/tmp/none', providerName: () => asProviderName('aws'), runQuery: () => Promise.resolve([]) });
    expect(resolveRollupSource(store, oneProvider, { start: '2026-01-01', end: '2026-01-31' }, 'daily', ['service', 'cost'])).toBeUndefined();
  });
  it('never routes a multi-provider query through the single-provider store', () => {
    const store = new RollupStore({ dataDir: '/tmp/none', providerName: () => asProviderName('aws'), runQuery: () => Promise.resolve([]) });
    const two: ProviderSourceSpec[] = [{ name: asProviderName('aws'), type: 'aws' }, { name: asProviderName('aws-b'), type: 'aws' }];
    expect(resolveRollupSource(store, two, { start: '2026-01-01', end: '2026-01-31' }, 'daily', ['service', 'cost'])).toBeUndefined();
  });
});

describe('providersEmptyForRange', () => {
  const range = { start: '2026-06-01', end: '2026-06-30' };
  it('is NOT empty when any provider has a month in range — even if the first does not', () => {
    const providers: ProviderSourceSpec[] = [
      { name: asProviderName('stale-payer'), type: 'aws', availablePeriods: ['2025-01', '2025-02'] },
      { name: asProviderName('active-payer'), type: 'aws', availablePeriods: ['2026-06'] },
    ];
    expect(providersEmptyForRange(providers, range)).toBe(false);
  });
  it('is empty when no provider intersects the range, and for an empty provider list', () => {
    expect(providersEmptyForRange([{ name: asProviderName('a'), type: 'aws', availablePeriods: ['2025-01'] }], range)).toBe(true);
    expect(providersEmptyForRange([], range)).toBe(true);
  });
});

