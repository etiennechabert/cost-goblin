import { asDimensionId, asTagValue } from '@costgoblin/core';
import type { BaselineScope, DimensionId, TagValue } from '@costgoblin/core';

/** A parsed JSON object, copied; throws on any other value. */
export function rec(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('expected a JSON object');
  return { ...v };
}

/** A single-service filter scope. */
export function svcScope(service: string): BaselineScope {
  const filters: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  filters[asDimensionId('service')] = [asTagValue(service)];
  return { kind: 'filter', filters };
}
