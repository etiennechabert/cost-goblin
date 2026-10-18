import type { OrgNode } from '../types/config.js';
import type { EntityRef } from '../types/branded.js';
import { asEntityRef } from '../types/branded.js';

export function getDescendantTagValues(node: OrgNode): string[] {
  if (node.virtual !== true && (node.children === undefined || node.children.length === 0)) {
    return [node.name];
  }
  if (node.children === undefined) {
    return [node.name];
  }
  const descendants = node.children.flatMap(getDescendantTagValues);
  if (node.virtual !== true) {
    return [node.name, ...descendants];
  }
  return descendants;
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

/** The owner values that filter values stand for under the tree: a node's
 *  name stands for every value the node rolls up (getDescendantTagValues), as
 *  its rolled-up row shows them; any other value, and a node that rolls up
 *  nothing (a virtual node with no children), stands for itself. Values
 *  appear once each, in first-seen order. */
export function expandOrgNodeValues(tree: readonly OrgNode[], values: readonly string[]): string[] {
  const expanded = new Set<string>();
  for (const value of values) {
    const node = findNode(tree, value);
    const members = node === undefined ? [] : getDescendantTagValues(node);
    for (const member of members.length > 0 ? members : [value]) expanded.add(member);
  }
  return [...expanded];
}

export function getAllLeafValues(tree: readonly OrgNode[]): string[] {
  return tree.flatMap(getDescendantTagValues);
}

export function findUnassignedValues(tree: readonly OrgNode[], allValues: readonly string[]): string[] {
  const assigned = new Set(getAllLeafValues(tree));
  return allValues.filter(v => !assigned.has(v));
}
