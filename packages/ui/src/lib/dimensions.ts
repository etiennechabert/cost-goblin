import type { Dimension, DimensionId, FilterMap, TagDimension, TagValue } from '@costgoblin/core/browser';
import { asDimensionId, asTagValue, tagDimColumn } from '@costgoblin/core/browser';

function isTagDim(dim: Dimension): dim is TagDimension {
  return !('field' in dim);
}

export function getDimensionId(dim: Dimension): DimensionId {
  if (isTagDim(dim)) {
    return asDimensionId(tagDimColumn(dim));
  }
  return dim.name;
}

export function getDimensionLabel(dim: Dimension): string {
  return dim.label;
}

export function isTagDimension(dim: Dimension): boolean {
  return isTagDim(dim);
}

export function isEnvironmentDimension(dim: Dimension): boolean {
  return isTagDim(dim) && dim.concept === 'environment';
}

export function isOwnerDimension(dim: Dimension): boolean {
  return isTagDim(dim) && dim.concept === 'owner';
}

export function isProductDimension(dim: Dimension): boolean {
  return isTagDim(dim) && dim.concept === 'product';
}

export function isUnitDimension(dim: Dimension): boolean {
  return isTagDim(dim) && dim.concept === 'unit';
}

/** Build a FilterMap seeded from each dim's `defaultFilterValues`. Used to
 *  initialise the global filter bar on view open. Dims without defaults are
 *  omitted, so an empty defaults set returns `{}`. */
export function defaultsFromDimensions(dimensions: readonly Dimension[]): FilterMap {
  const out: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const d of dimensions) {
    const values = d.defaultFilterValues;
    if (values === undefined || values.length === 0) continue;
    out[getDimensionId(d)] = values.map(v => asTagValue(v));
  }
  return out;
}
