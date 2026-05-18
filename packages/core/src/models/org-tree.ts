import type { OrgNode } from '../types/config.js';
import type { EntityRef } from '../types/branded.js';
import { asEntityRef } from '../types/branded.js';

/** Validator invariant: a node with children is always virtual. So a leaf
 *  (no children) is itself a tag value; a parent (always virtual) contributes
 *  only its descendants, never its own name. */
export function getDescendantTagValues(node: OrgNode): string[] {
  if (node.children === undefined || node.children.length === 0) {
    return [node.name];
  }
  return node.children.flatMap(getDescendantTagValues);
}

export function findNode(tree: readonly OrgNode[], name: string): OrgNode | undefined {
  for (const node of tree) {
    if (node.name === name) {
      return node;
    }
    if (node.children !== undefined) {
      const found = findNode(node.children, name);
      if (found !== undefined) {
        return found;
      }
    }
  }
  return undefined;
}

export function getAncestorPath(tree: readonly OrgNode[], name: string): readonly EntityRef[] {
  function walk(nodes: readonly OrgNode[], path: EntityRef[]): readonly EntityRef[] | undefined {
    for (const node of nodes) {
      const currentPath = [...path, asEntityRef(node.name)];
      if (node.name === name) {
        return currentPath;
      }
      if (node.children !== undefined) {
        const found = walk(node.children, currentPath);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  }
  return walk(tree, []) ?? [asEntityRef(name)];
}

export function getAllLeafValues(tree: readonly OrgNode[]): string[] {
  return tree.flatMap(getDescendantTagValues);
}

export function findUnassignedValues(tree: readonly OrgNode[], allValues: readonly string[]): string[] {
  const assigned = new Set(getAllLeafValues(tree));
  return allValues.filter(v => !assigned.has(v));
}
