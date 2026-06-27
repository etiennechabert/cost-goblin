import { parseJsonObject } from '@costgoblin/core';

/**
 * Serializes read-modify-write cycles on a shared preferences JSON file.
 *
 * Three IPC handlers persist into ui-preferences.json — `ui:save-preferences`,
 * `perf:set`, and `telemetry:set-preferences` — each merging only its own slice.
 * Run concurrently, two of them both read the old file and the later write drops
 * the earlier slice (e.g. saving a theme could clobber a just-enabled telemetry
 * opt-in). A per-path promise chain makes each read-modify-write atomic against
 * the others.
 */
const chains = new Map<string, Promise<unknown>>();

export async function updatePrefsFile(
  filePath: string,
  mutate: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Promise<void> {
  const prev = chains.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    const fs = await import('node:fs/promises');
    let current: Readonly<Record<string, unknown>> = {};
    try {
      current = parseJsonObject(await fs.readFile(filePath, 'utf-8')) ?? {};
    } catch {
      // No file yet — start from an empty object.
    }
    const merged = mutate(current);
    await fs.writeFile(filePath, JSON.stringify(merged, null, 2));
  });
  // Swallow failures on the stored chain so one failed write doesn't wedge every
  // later write on this file; the caller still observes its own rejection.
  chains.set(filePath, next.catch(() => undefined));
  return next;
}
