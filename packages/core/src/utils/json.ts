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
