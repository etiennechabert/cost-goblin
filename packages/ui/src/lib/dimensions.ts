import type { Dimension, DimensionId, TagDimension } from '@costgoblin/core/browser';
import { asDimensionId, tagDimColumn } from '@costgoblin/core/browser';

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
