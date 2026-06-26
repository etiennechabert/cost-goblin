import { createHash } from 'node:crypto';

/** Locale-independent code-unit comparator — matches the default `Array#sort`
 *  string ordering exactly, so the digest stays deterministic across locales. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Deterministic JSON: object keys sorted recursively so cosmetic key-order or
 *  whitespace never changes the digest. Arrays preserve order — callers sort
 *  array contents where order should not matter. `undefined` serializes as
 *  `null` so optional fields are stable. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodeUnits);
  const entries = keys.map(k => {
    const pair = `${JSON.stringify(k)}:${canonicalJson(obj[k])}`;
    return pair;
  });
  return `{${entries.join(',')}}`;
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}
