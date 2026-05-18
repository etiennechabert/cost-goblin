import { describe, it, expect } from 'vitest';
import {
  pathsEqual,
  isPathDescendantOf,
  getNodeAtPath,
  updateNodeAtPath,
  removeNodeAtPath,
  insertNodeAtPath,
  moveNode,
  appendChild,
} from '../models/org-tree-edit.js';
import type { OrgNode } from '../types/config.js';

const tree: readonly OrgNode[] = [
  {
    name: 'engineering',
    virtual: true,
    children: [
      { name: 'platform', children: [{ name: 'backend' }, { name: 'frontend' }] },
      { name: 'data', children: [{ name: 'analytics' }] },
    ],
  },
  { name: 'growth' },
];

describe('pathsEqual', () => {
  it('compares paths', () => {
    expect(pathsEqual([0, 1], [0, 1])).toBe(true);
    expect(pathsEqual([], [])).toBe(true);
    expect(pathsEqual([0, 1], [0, 2])).toBe(false);
    expect(pathsEqual([0], [0, 0])).toBe(false);
  });
});

describe('isPathDescendantOf', () => {
  it('true for self and descendants', () => {
    expect(isPathDescendantOf([0, 1], [0, 1])).toBe(true);
    expect(isPathDescendantOf([0, 1, 2], [0, 1])).toBe(true);
  });

  it('false for non-descendants', () => {
    expect(isPathDescendantOf([0], [0, 1])).toBe(false);
    expect(isPathDescendantOf([1], [0])).toBe(false);
  });
});

describe('getNodeAtPath', () => {
  it('returns the node at the path', () => {
    expect(getNodeAtPath(tree, [0])?.name).toBe('engineering');
    expect(getNodeAtPath(tree, [0, 0, 1])?.name).toBe('frontend');
  });

  it('returns undefined for invalid path', () => {
    expect(getNodeAtPath(tree, [9])).toBeUndefined();
    expect(getNodeAtPath(tree, [0, 9])).toBeUndefined();
    expect(getNodeAtPath(tree, [1, 0])).toBeUndefined();
  });
});

describe('updateNodeAtPath', () => {
  it('renames a leaf', () => {
    const next = updateNodeAtPath(tree, [0, 0, 0], (n) => ({ ...n, name: 'api' }));
    expect(getNodeAtPath(next, [0, 0, 0])?.name).toBe('api');
    expect(getNodeAtPath(tree, [0, 0, 0])?.name).toBe('backend');
  });

  it('returns the same tree on invalid path', () => {
    const next = updateNodeAtPath(tree, [9], (n) => n);
    expect(next).toBe(tree);
  });
});

describe('removeNodeAtPath', () => {
  it('removes a root node', () => {
    const next = removeNodeAtPath(tree, [1]);
    expect(next).toHaveLength(1);
    expect(next[0]?.name).toBe('engineering');
  });

  it('removes a deeply nested node', () => {
    const next = removeNodeAtPath(tree, [0, 0, 1]);
    expect(getNodeAtPath(next, [0, 0])?.children).toHaveLength(1);
    expect(getNodeAtPath(next, [0, 0, 0])?.name).toBe('backend');
  });

  it('no-op on invalid path', () => {
    expect(removeNodeAtPath(tree, [])).toBe(tree);
    expect(removeNodeAtPath(tree, [9])).toEqual(tree);
  });
});

describe('insertNodeAtPath', () => {
  it('inserts at root', () => {
    const next = insertNodeAtPath(tree, [], 1, { name: 'new' });
    expect(next.map(n => n.name)).toEqual(['engineering', 'new', 'growth']);
  });

  it('inserts as a child', () => {
    const next = insertNodeAtPath(tree, [0, 0], 0, { name: 'first' });
    const platformChildren = getNodeAtPath(next, [0, 0])?.children ?? [];
    expect(platformChildren.map(n => n.name)).toEqual(['first', 'backend', 'frontend']);
  });

  it('clamps to bounds', () => {
    const next = insertNodeAtPath(tree, [], 100, { name: 'last' });
    expect(next[next.length - 1]?.name).toBe('last');
  });
});

describe('moveNode', () => {
  it('moves across parents', () => {
    const next = moveNode(tree, [0, 0, 0], [0, 1], 0);
    expect(getNodeAtPath(next, [0, 0])?.children).toHaveLength(1);
    expect(getNodeAtPath(next, [0, 1, 0])?.name).toBe('backend');
  });

  it('reorders within the same parent', () => {
    const next = moveNode(tree, [0, 0, 0], [0, 0], 2);
    const platformChildren = getNodeAtPath(next, [0, 0])?.children ?? [];
    expect(platformChildren.map(n => n.name)).toEqual(['frontend', 'backend']);
  });

  it('refuses to move a node into its own subtree', () => {
    const next = moveNode(tree, [0], [0, 0], 0);
    expect(next).toBe(tree);
  });

  it('moves a root node into a child position', () => {
    const next = moveNode(tree, [1], [0], 0);
    expect(next).toHaveLength(1);
    expect(getNodeAtPath(next, [0, 0])?.name).toBe('growth');
  });
});

describe('appendChild', () => {
  it('appends at root', () => {
    const { tree: next, path } = appendChild(tree, [], { name: 'ml' });
    expect(path).toEqual([2]);
    expect(getNodeAtPath(next, [2])?.name).toBe('ml');
  });

  it('appends as a child of an internal node', () => {
    const { tree: next, path } = appendChild(tree, [0, 0], { name: 'shared' });
    expect(path).toEqual([0, 0, 2]);
    expect(getNodeAtPath(next, [0, 0, 2])?.name).toBe('shared');
  });

  it('appends as the first child of a leaf', () => {
    const { tree: next, path } = appendChild(tree, [1], { name: 'sub' });
    expect(path).toEqual([1, 0]);
    expect(getNodeAtPath(next, [1, 0])?.name).toBe('sub');
  });
});
