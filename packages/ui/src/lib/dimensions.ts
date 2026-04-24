import type { Dimension, DimensionId } from '@costgoblin/core/browser';
import { asDimensionId, tagColumnName } from '@costgoblin/core/browser';

export function getDimensionId(dim: Dimension): DimensionId {
  if ('tagName' in dim) {
    return asDimensionId(tagColumnName(dim.tagName));
  }
  return dim.name;
}

export function getDimensionLabel(dim: Dimension): string {
  return dim.label;
}

export function isTagDimension(dim: Dimension): boolean {
  return 'tagName' in dim;
}

export function isEnvironmentDimension(dim: Dimension): boolean {
  return 'tagName' in dim && dim.concept === 'environment';
}

export function isOwnerDimension(dim: Dimension): boolean {
  return 'tagName' in dim && dim.concept === 'owner';
}

export function isProductDimension(dim: Dimension): boolean {
  return 'tagName' in dim && dim.concept === 'product';
}
