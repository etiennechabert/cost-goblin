import { createHash } from 'node:crypto';

/** Deterministic JSON: object keys sorted recursively so cosmetic key-order or
 *  whitespace never changes the digest. Arrays preserve order — callers sort
 *  array contents where order should not matter. `undefined` serializes as
 *  `null` so optional fields are stable. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
