import { describe, it, expect } from 'vitest';
import {
  getDescendantTagValues,
  expandOrgNodeValues,
  findNode,
  getAncestorPath,
  getAllLeafValues,
  findUnassignedValues,
} from '../models/org-tree.js';
import type { OrgNode } from '../types/config.js';

const engineering: OrgNode = {
  name: 'Engineering',
  virtual: true,
  children: [
    { name: 'core-banking' },
    { name: 'payments' },
    { name: 'identity' },
    { name: 'platform' },
  ],
};

const data: OrgNode = {
  name: 'Data',
  virtual: true,
  children: [
    { name: 'analytics' },
    { name: 'ml-platform' },
  ],
};

const sre: OrgNode = {
  name: 'SRE',
  children: [
    { name: 'sre-emea' },
    { name: 'sre-us' },
  ],
};

const company: OrgNode = {
  name: 'Company',
  virtual: true,
  children: [engineering, data, sre],
};

const tree: readonly OrgNode[] = [company];

describe('getDescendantTagValues', () => {
  it('returns leaf name for leaf node', () => {
    expect(getDescendantTagValues({ name: 'core-banking' })).toEqual(['core-banking']);
  });

  it('returns all descendants for virtual node', () => {
    const values = getDescendantTagValues(engineering);
    expect(values).toEqual(['core-banking', 'payments', 'identity', 'platform']);
  });

  it('includes self for non-virtual node with children', () => {
    const values = getDescendantTagValues(sre);
    expect(values).toEqual(['SRE', 'sre-emea', 'sre-us']);
  });

  it('returns all leaf values for root', () => {
    const values = getDescendantTagValues(company);
    expect(values).toContain('core-banking');
    expect(values).toContain('analytics');
    expect(values).toContain('sre-emea');
    expect(values).toHaveLength(9);
  });
});

describe('findNode', () => {
  it('finds a top-level node', () => {
    const node = findNode(tree, 'Company');
    expect(node?.name).toBe('Company');
  });

  it('finds a deeply nested node', () => {
    const node = findNode(tree, 'core-banking');
    expect(node?.name).toBe('core-banking');
  });

  it('returns undefined for non-existent node', () => {
    expect(findNode(tree, 'nonexistent')).toBeUndefined();
  });
});

describe('getAncestorPath', () => {
  it('returns full path from root to leaf', () => {
    const path = getAncestorPath(tree, 'core-banking');
    expect(path).toEqual(['Company', 'Engineering', 'core-banking']);
  });

  it('returns path for node with children', () => {
    const path = getAncestorPath(tree, 'SRE');
    expect(path).toEqual(['Company', 'SRE']);
  });

  it('returns self for unknown node', () => {
    const path = getAncestorPath(tree, 'unknown');
    expect(path).toEqual(['unknown']);
  });
});

describe('expandOrgNodeValues', () => {
  it('stands a node\'s name for itself and every value it rolls up, at any depth', () => {
    expect(expandOrgNodeValues(tree, ['Engineering'])).toEqual(['Engineering', 'core-banking', 'payments', 'identity', 'platform']);
    expect(expandOrgNodeValues(tree, ['SRE'])).toEqual(['SRE', 'sre-emea', 'sre-us']);
    expect(expandOrgNodeValues(tree, ['Company'])).toEqual(['Company', ...getDescendantTagValues(company)]);
  });

  it('keeps a leaf or a value outside the tree as itself, each value once', () => {
    expect(expandOrgNodeValues(tree, ['payments', 'new-team'])).toEqual(['payments', 'new-team']);
    expect(expandOrgNodeValues(tree, ['Engineering', 'payments', 'SRE'])).toEqual(['Engineering', 'core-banking', 'payments', 'identity', 'platform', 'SRE', 'sre-emea', 'sre-us']);
  });

  it('keeps a node that rolls up nothing, or a name in no tree, as itself', () => {
    const empty: OrgNode[] = [{ name: 'Empty', virtual: true, children: [] }];
    expect(expandOrgNodeValues(empty, ['Empty'])).toEqual(['Empty']);
    expect(expandOrgNodeValues([], ['Company'])).toEqual(['Company']);
  });
});

describe('getAllLeafValues', () => {
  it('returns all leaf values from tree', () => {
    const values = getAllLeafValues(tree);
    expect(values).toContain('core-banking');
    expect(values).toContain('ml-platform');
    expect(values).toContain('sre-us');
  });
});

describe('findUnassignedValues', () => {
  it('finds values not in tree', () => {
    const allValues = ['core-banking', 'payments', 'new-team', 'another-team'];
    const unassigned = findUnassignedValues(tree, allValues);
    expect(unassigned).toEqual(['new-team', 'another-team']);
  });

  it('returns empty when all assigned', () => {
    const unassigned = findUnassignedValues(tree, ['core-banking', 'payments']);
    expect(unassigned).toEqual([]);
  });
});
