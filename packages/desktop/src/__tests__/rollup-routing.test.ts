import { describe, it, expect } from 'vitest';
import { type DimensionsConfig, asDimensionId } from '@costgoblin/core';
import { columnForDimension, resolveRollupSource } from '../main/handlers/query-utils.js';
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
    expect(columnForDimension(dims, 'tag_team')).toBe('tag_team');
  });
  it('returns an unknown/disabled id unchanged (so it gates out of the rollup grain)', () => {
    expect(columnForDimension(dims, 'resource_id')).toBe('resource_id');
  });
});

describe('resolveRollupSource', () => {
  it('returns undefined when the store has no valid partitions (falls back to raw)', () => {
    const store = new RollupStore({ dataDir: '/tmp/none', runQuery: () => Promise.resolve([]) });
    expect(resolveRollupSource(store, { start: '2026-01-01', end: '2026-01-31' }, 'daily', ['service', 'cost'])).toBeUndefined();
  });
});
