import type { CostResult, CostRow } from '../types/query.js';
import type { OrgNode } from '../types/config.js';
import { asDollars, asEntityRef } from '../types/branded.js';
import { getDescendantTagValues } from './org-tree.js';

function mergeDescendantCosts(
  descendants: readonly string[],
  entityCostMap: Map<string, CostRow>,
  consumedEntities: Set<string>,
): { totalCost: number; mergedServices: Record<string, number> } {
  let totalCost = 0;
  const mergedServices: Record<string, number> = {};
  for (const desc of descendants) {
    consumedEntities.add(desc);
    const row = entityCostMap.get(desc);
    if (row === undefined) continue;
    totalCost += row.totalCost;
    for (const [svc, cost] of Object.entries(row.serviceCosts)) {
      mergedServices[svc] = (mergedServices[svc] ?? 0) + cost;
    }
  }
  return { totalCost, mergedServices };
}

function makeVirtualRow(name: string, totalCost: number, mergedServices: Record<string, number>): CostRow | null {
  if (totalCost <= 0) return null;
  return {
    entity: asEntityRef(name),
    totalCost: asDollars(totalCost),
    serviceCosts: Object.fromEntries(
      Object.entries(mergedServices).map(([k, v]) => [k, asDollars(v)]),
    ),
    isVirtual: true,
  };
}

/** Validator invariant: the tree has exactly one virtual root. We roll up at
 *  the root's children — one row per direct child (rolled up if it has its own
 *  children, raw cost row if it's a leaf) — so the table shows departments and
 *  unsorted teams side by side instead of collapsing to a single "Organization"
 *  entry. */
export function applyOrgTreeRollup(result: CostResult, tree: readonly OrgNode[]): CostResult {
  const topLevel = tree[0]?.children ?? [];

  const entityCostMap = new Map<string, CostRow>();
  for (const row of result.rows) entityCostMap.set(row.entity, row);

  const rolledUpRows: CostRow[] = [];
  const consumedEntities = new Set<string>();

  for (const node of topLevel) {
    if (node.children === undefined || node.children.length === 0) {
      const row = entityCostMap.get(node.name);
      if (row !== undefined) {
        rolledUpRows.push(row);
        consumedEntities.add(node.name);
      }
      continue;
    }
    const descendants = getDescendantTagValues(node);
    const { totalCost, mergedServices } = mergeDescendantCosts(descendants, entityCostMap, consumedEntities);
    const row = makeVirtualRow(node.name, totalCost, mergedServices);
    if (row !== null) rolledUpRows.push(row);
  }

  for (const row of result.rows) {
    if (!consumedEntities.has(row.entity) && !rolledUpRows.some(r => r.entity === row.entity)) {
      rolledUpRows.push(row);
    }
  }

  return { ...result, rows: rolledUpRows };
}
