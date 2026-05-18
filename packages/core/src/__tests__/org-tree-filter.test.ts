import { describe, it, expect } from 'vitest';
import { expandOrgFilters } from '../models/org-tree-filter.js';
import { asDimensionId, asTagValue } from '../types/branded.js';
import type { OrgNode } from '../types/config.js';

const ownerDim = asDimensionId('tag_owner');
const accountDim = asDimensionId('account_id');

const tree: readonly OrgNode[] = [{
  name: 'Organization',
  virtual: true,
  children: [
    { name: 'engineering', virtual: true, children: [{ name: 'backend' }, { name: 'frontend' }] },
    { name: 'data', virtual: true, children: [{ name: 'analytics' }] },
    { name: 'lone-team' },
  ],
}];

describe('expandOrgFilters', () => {
  it('expands a virtual department to its descendant leaves', () => {
    const out = expandOrgFilters({ [ownerDim]: [asTagValue('engineering')] }, ownerDim, tree);
    expect(out[ownerDim]).toEqual(['backend', 'frontend']);
  });

  it('passes leaf values through unchanged', () => {
    const filters = { [ownerDim]: [asTagValue('backend'), asTagValue('lone-team')] };
    const out = expandOrgFilters(filters, ownerDim, tree);
    expect(out).toBe(filters);
  });

  it('mixes leaves and virtuals correctly', () => {
    const out = expandOrgFilters(
      { [ownerDim]: [asTagValue('engineering'), asTagValue('lone-team')] },
      ownerDim,
      tree,
    );
    expect(out[ownerDim]).toEqual(['backend', 'frontend', 'lone-team']);
  });

  it('dedupes when virtuals overlap with picked leaves', () => {
    const out = expandOrgFilters(
      { [ownerDim]: [asTagValue('engineering'), asTagValue('backend')] },
      ownerDim,
      tree,
    );
    expect(out[ownerDim]).toEqual(['backend', 'frontend']);
  });

  it('passes unknown values through (defensive)', () => {
    const out = expandOrgFilters(
      { [ownerDim]: [asTagValue('not-in-tree')] },
      ownerDim,
      tree,
    );
    expect(out[ownerDim]).toEqual(['not-in-tree']);
  });

  it('expands the synthetic root to every leaf', () => {
    const out = expandOrgFilters(
      { [ownerDim]: [asTagValue('Organization')] },
      ownerDim,
      tree,
    );
    expect(new Set(out[ownerDim])).toEqual(new Set(['backend', 'frontend', 'analytics', 'lone-team']));
  });

  it('leaves filters for other dimensions untouched', () => {
    const filters = {
      [ownerDim]: [asTagValue('engineering')],
      [accountDim]: [asTagValue('111111111111')],
    };
    const out = expandOrgFilters(filters, ownerDim, tree);
    expect(out[accountDim]).toBe(filters[accountDim]);
  });

  it('returns the input unchanged when ownerDimensionId is undefined', () => {
    const filters = { [ownerDim]: [asTagValue('engineering')] };
    const out = expandOrgFilters(filters, undefined, tree);
    expect(out).toBe(filters);
  });

  it('returns the input unchanged when owner filter is empty', () => {
    const filters = {};
    const out = expandOrgFilters(filters, ownerDim, tree);
    expect(out).toBe(filters);
  });
});
