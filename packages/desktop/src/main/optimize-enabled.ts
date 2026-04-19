import { parseJsonObject } from '@costgoblin/core';

const KEY = 'optimizeEnabled';

/** Default to enabled — the optimizer is the whole point of the local layer. */
export async function readOptimizeEnabled(prefsPath: string): Promise<boolean> {
  const fs = await import('node:fs/promises');
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    const parsed = parseJsonObject(raw);
    if (parsed === null) return true;
    const value = parsed[KEY];
    if (value === false) return false;
    return true;
  } catch {
    return true;
  }
}

export async function writeOptimizeEnabled(prefsPath: string, enabled: boolean): Promise<void> {
  const fs = await import('node:fs/promises');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(prefsPath, 'utf-8');
    const parsed = parseJsonObject(raw);
    if (parsed !== null) existing = { ...parsed };
  } catch { /* missing file */ }
  existing[KEY] = enabled;
  await fs.writeFile(prefsPath, JSON.stringify(existing, null, 2));
}
