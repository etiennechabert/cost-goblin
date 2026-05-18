import type { FilterMap } from '../types/query.js';
import type { DimensionsConfig, OrgNode } from '../types/config.js';
import type { DimensionId, TagValue } from '../types/branded.js';
import { asDimensionId, asTagValue, tagColumnName } from '../types/branded.js';
import { findNode, getDescendantTagValues } from './org-tree.js';

/** Returns the DimensionId for the dimension marked `concept: 'owner'`, if any.
 *  Only one such dimension is expected per config. */
export function getOwnerDimensionId(dimensions: DimensionsConfig): DimensionId | undefined {
  const tag = dimensions.tags.find(t => t.concept === 'owner');
  return tag === undefined ? undefined : asDimensionId(tagColumnName(tag.tagName));
}

function expandOwnerValues(
  values: readonly string[],
  tree: readonly OrgNode[],
): { expanded: string[]; touched: boolean } {
  const expanded: string[] = [];
  let touched = false;
  for (const value of values) {
    const node = findNode(tree, value);
    if (node !== undefined && node.children !== undefined && node.children.length > 0) {
      for (const desc of getDescendantTagValues(node)) expanded.push(desc);
      touched = true;
    } else {
      expanded.push(value);
    }
  }
  return { expanded: Array.from(new Set(expanded)), touched };
}

/** Replace any virtual-department values on the owner dimension (in the typed
 *  `FilterMap` used by query builders) with their descendant leaf tag values.
 *  Leaf values and unknown values pass through. */
export function expandOrgFilters(
  filters: FilterMap,
  ownerDimensionId: DimensionId | undefined,
  tree: readonly OrgNode[],
): FilterMap {
  if (ownerDimensionId === undefined) return filters;
  const ownerValues = filters[ownerDimensionId];
  if (ownerValues === undefined || ownerValues.length === 0) return filters;
  const { expanded, touched } = expandOwnerValues(ownerValues, tree);
  if (!touched) return filters;
  const branded: readonly TagValue[] = expanded.map(asTagValue);
  return { ...filters, [ownerDimensionId]: branded };
}

/** Same logic, plain-string variant used at IPC boundaries where the filter
 *  map arrives unbranded. */
export function expandOrgFiltersPlain(
  filters: Readonly<Record<string, readonly string[]>>,
  ownerDimensionId: string | undefined,
  tree: readonly OrgNode[],
): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = { ...filters };
  if (ownerDimensionId === undefined) return out;
  const ownerValues = filters[ownerDimensionId];
  if (ownerValues === undefined || ownerValues.length === 0) return out;
  const { expanded, touched } = expandOwnerValues(ownerValues, tree);
  if (!touched) return out;
  out[ownerDimensionId] = expanded;
  return out;
}
