import { logger, parseJsonObject, quarantineFile, readTextIfExists, writeFileAtomic } from '@costgoblin/core';

/**
 * Serializes read-modify-write cycles on a shared preferences JSON file.
 *
 * Four IPC handlers persist into ui-preferences.json — `ui:save-preferences`,
 * `perf:set`, `telemetry:set-preferences` and `mcp:set-running` — each merging
 * only its own slice.
 * Run concurrently, two of them both read the old file and the later write drops
 * the earlier slice (e.g. saving a theme could clobber a just-enabled telemetry
 * opt-in). A per-path promise chain makes each read-modify-write atomic against
 * the others.
 */
const chains = new Map<string, Promise<unknown>>();

/** The file's slices, {} only when it doesn't exist yet. Any other read
 *  failure throws and leaves the file alone: merging one slice into {} after
 *  a transient EBUSY would write every other slice away. A file that isn't a
 *  JSON object (a write torn under an older build, a bad hand edit) is moved
 *  aside — bytes kept for recovery — and the update starts afresh. */
async function readPrefs(filePath: string): Promise<Readonly<Record<string, unknown>>> {
  const text = await readTextIfExists(filePath);
  if (text === null) return {};
  // Tolerate the UTF-8 BOM some Windows editors add to a hand-edited file.
  const parsed = parseJsonObject(text.replace(/^\uFEFF/, ''));
  if (parsed !== null) return parsed;
  const movedTo = await quarantineFile(filePath);
  logger.error('prefs: unreadable preferences file; moved it aside and started afresh', { file: filePath, movedTo });
  return {};
}

export async function updatePrefsFile(
  filePath: string,
  mutate: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Promise<void> {
  const prev = chains.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    const merged = mutate(await readPrefs(filePath));
    await writeFileAtomic(filePath, JSON.stringify(merged, null, 2));
  });
  // Swallow failures on the stored chain so one failed write doesn't wedge every
  // later write on this file; the caller still observes its own rejection.
  chains.set(filePath, next.catch(() => undefined));
  return next;
}
