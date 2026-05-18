import type { OrgNode, OrgTreeConfig } from '../types/config.js';

/** YAML-ready shape for a single org tree node. Keeps keys in a stable order so
 *  round-tripping a config doesn't produce noisy diffs. */
function nodeToYaml(node: OrgNode): Record<string, unknown> {
  const out: Record<string, unknown> = { name: node.name };

  if (node.virtual === true) {
    out['virtual'] = true;
  }

  if (node.children !== undefined && node.children.length > 0) {
    out['children'] = node.children.map(nodeToYaml);
  }

  return out;
}

export function orgTreeToYaml(config: OrgTreeConfig): { tree: unknown[] } {
  return {
    tree: config.tree.map(nodeToYaml),
  };
}
