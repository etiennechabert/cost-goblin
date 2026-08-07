export function isStringRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseJsonObject(raw: string): Readonly<Record<string, unknown>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isStringRecord(parsed) ? parsed : null;
}

/** Sister of `parseJsonObject` for the top-level-array payloads a CLI emits —
 *  `gcloud projects list --format=json` is one. Elements stay `unknown`: the
 *  caller narrows each with `isStringRecord`, so nothing reaches a typed shape
 *  without a guard. */
export function parseJsonArray(raw: string): readonly unknown[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return Array.isArray(parsed) ? parsed : null;
}
