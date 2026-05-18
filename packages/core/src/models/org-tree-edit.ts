import type { OrgNode } from '../types/config.js';

/** Path to a node = sibling indices from root. `[0, 2, 1]` means
 *  `tree[0].children[2].children[1]`. */
export type NodePath = readonly number[];

export function pathsEqual(a: NodePath, b: NodePath): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** True if `descendant` is `ancestor` itself or any node beneath it. Used to
 *  prevent dropping a node into its own subtree. */
export function isPathDescendantOf(descendant: NodePath, ancestor: NodePath): boolean {
  if (descendant.length < ancestor.length) return false;
  for (let i = 0; i < ancestor.length; i++) {
    if (descendant[i] !== ancestor[i]) return false;
  }
  return true;
}

function getNode(tree: readonly OrgNode[], path: NodePath): OrgNode | undefined {
  let current: readonly OrgNode[] | undefined = tree;
  let node: OrgNode | undefined;
  for (const idx of path) {
    if (current === undefined || idx < 0 || idx >= current.length) return undefined;
    node = current[idx];
    current = node?.children;
  }
  return node;
}

export function getNodeAtPath(tree: readonly OrgNode[], path: NodePath): OrgNode | undefined {
  return getNode(tree, path);
}

export function updateNodeAtPath(
  tree: readonly OrgNode[],
  path: NodePath,
  updater: (node: OrgNode) => OrgNode,
): readonly OrgNode[] {
  if (path.length === 0) return tree;
  const [index, ...rest] = path;
  if (index === undefined || index < 0 || index >= tree.length) return tree;
  return tree.map((node, idx) => {
    if (idx !== index) return node;
    if (rest.length === 0) return updater(node);
    if (node.children === undefined) return node;
    return { ...node, children: updateNodeAtPath(node.children, rest, updater) };
  });
}

export function removeNodeAtPath(tree: readonly OrgNode[], path: NodePath): readonly OrgNode[] {
  if (path.length === 0) return tree;
  if (path.length === 1) {
    const idx = path[0];
    if (idx === undefined || idx < 0 || idx >= tree.length) return tree;
    return [...tree.slice(0, idx), ...tree.slice(idx + 1)];
  }
  const parentPath = path.slice(0, -1);
  const lastIdx = path[path.length - 1];
  if (lastIdx === undefined) return tree;
  return updateNodeAtPath(tree, parentPath, (parent) => {
    const children = parent.children ?? [];
    if (lastIdx < 0 || lastIdx >= children.length) return parent;
    return { ...parent, children: [...children.slice(0, lastIdx), ...children.slice(lastIdx + 1)] };
  });
}

/** Insert `node` as a child of the node at `parentPath` at position `insertIdx`.
 *  `parentPath = []` inserts into the root array. */
export function insertNodeAtPath(
  tree: readonly OrgNode[],
  parentPath: NodePath,
  insertIdx: number,
  node: OrgNode,
): readonly OrgNode[] {
  if (parentPath.length === 0) {
    const clamped = Math.max(0, Math.min(insertIdx, tree.length));
    return [...tree.slice(0, clamped), node, ...tree.slice(clamped)];
  }
  return updateNodeAtPath(tree, parentPath, (parent) => {
    const children = parent.children ?? [];
    const clamped = Math.max(0, Math.min(insertIdx, children.length));
    return { ...parent, children: [...children.slice(0, clamped), node, ...children.slice(clamped)] };
  });
}

/** Move the node at `fromPath` to be a child of `toParentPath` at index
 *  `toIdx`. No-op if the move would put a node inside its own subtree. */
export function moveNode(
  tree: readonly OrgNode[],
  fromPath: NodePath,
  toParentPath: NodePath,
  toIdx: number,
): readonly OrgNode[] {
  if (isPathDescendantOf(toParentPath, fromPath)) return tree;
  const node = getNode(tree, fromPath);
  if (node === undefined) return tree;

  const removed = removeNodeAtPath(tree, fromPath);

  const fromParent = fromPath.slice(0, -1);
  const fromIdx = fromPath[fromPath.length - 1];
  let adjustedIdx = toIdx;
  if (pathsEqual(fromParent, toParentPath) && fromIdx !== undefined && toIdx > fromIdx) {
    adjustedIdx = toIdx - 1;
  }
  return insertNodeAtPath(removed, toParentPath, adjustedIdx, node);
}

/** Append `node` as the last child of the node at `parentPath`, returning the
 *  new tree and the path of the inserted node. `parentPath = []` appends at
 *  root. */
export function appendChild(
  tree: readonly OrgNode[],
  parentPath: NodePath,
  node: OrgNode,
): { tree: readonly OrgNode[]; path: NodePath } {
  if (parentPath.length === 0) {
    return { tree: [...tree, node], path: [tree.length] };
  }
  const parent = getNode(tree, parentPath);
  const childCount = parent?.children?.length ?? 0;
  return {
    tree: insertNodeAtPath(tree, parentPath, childCount, node),
    path: [...parentPath, childCount],
  };
}
