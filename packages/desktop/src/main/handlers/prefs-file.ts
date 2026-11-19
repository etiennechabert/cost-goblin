import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { logger, parseJsonObject } from '@costgoblin/core';
import { errnoCode, isEnoent } from '../fs-errors.js';

/**
 * Read-modify-write of a shared preferences JSON file: the workspace's
 * ui-preferences.json, explorer-preferences.json and savings-preferences.json,
 * and the machine's app-state.json.
 *
 *  - Serialized per path. Several IPC handlers persist into one file, each
 *    merging only its own slice (`ui:save-preferences`, `perf:set`,
 *    `telemetry:set-preferences`, `mcp:set-running`, ...). Run concurrently,
 *    two of them both read the old file and the later write drops the earlier
 *    slice (saving a theme could clobber a just-enabled telemetry opt-in). A
 *    per-path promise chain makes each read-modify-write atomic against the
 *    others.
 *  - Replaced, never rewritten. The readers of these files don't go through
 *    the chain (`ui:get-preferences`, the launch-time reads in main.ts,
 *    `readAppStateSync`, ...) and take a file that doesn't parse for one with
 *    no preferences. The new contents therefore go to a temp file that is
 *    renamed over the target, so a reader, or the next launch after a crash
 *    mid-save, finds the old file or the new one, never a truncated one. See
 *    `replaceFile` for what Windows does to that rename.
 *  - Only a missing file is "no file yet". One that is there but can't be read
 *    (EACCES, EISDIR, EMFILE) rejects the update: read as empty, this save
 *    would replace every other slice with its own, and a rename needs no
 *    access to the file it replaces. One that reads but holds no JSON object
 *    (empty or cut short by a save from before the rename, hand-edited) has
 *    nothing to merge and no reader that takes it for anything but defaults,
 *    so the save starts it over, and logs that it did.
 */
const chains = new Map<string, Promise<unknown>>();

export async function updatePrefsFile(
  filePath: string,
  mutate: (current: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): Promise<void> {
  const prev = chains.get(filePath) ?? Promise.resolve();
  const next = prev.then(async () => {
    const merged = mutate(await readCurrent(filePath));
    await replaceFile(filePath, JSON.stringify(merged, null, 2));
  });
  // Swallow failures on the stored chain so one failed write doesn't wedge every
  // later write on this file; the caller still observes its own rejection.
  chains.set(filePath, next.catch(() => undefined));
  return next;
}

async function readCurrent(filePath: string): Promise<Readonly<Record<string, unknown>>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (isEnoent(err)) return {};
    throw err;
  }
  const parsed = parseJsonObject(raw);
  if (parsed !== null) return parsed;
  // The name only: the path holds the user's home directory.
  logger.warn(`prefs: ${basename(filePath)} holds no JSON object; this save starts it over`);
  return {};
}

// What Windows fails a rename with while another handle is open on the target
// or on the temp file: antivirus or the indexer looking at the file just
// written, or one of this app's own readers in the middle of a read. Each lets
// go within milliseconds.
const RENAME_REFUSED_CODES: readonly string[] = ['EPERM', 'EACCES', 'EBUSY'];
const RENAME_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100];

/** Renames `tempPath` over `filePath`, waiting out a refusal. Resolves null
 *  once renamed, or the code the last refusal carried when the retries ran
 *  out. Any other failure rejects. */
async function renameOver(tempPath: string, filePath: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tempPath, filePath);
      return null;
    } catch (err: unknown) {
      const code = errnoCode(err);
      if (code === undefined || !RENAME_REFUSED_CODES.includes(code)) throw err;
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) return code;
      await sleep(delayMs);
    }
  }
}

/** Replaces `filePath` with `contents` by renaming a finished temp file over
 *  it. A failed write or rename leaves the file as it was and removes the temp
 *  file.
 *
 *  The one exception is a rename the system keeps refusing (Windows, see
 *  `RENAME_REFUSED_CODES`): after the retries the file is written in place,
 *  which is what every save did before, so a held file costs that save its
 *  atomicity rather than the preference. The codes are not checked against the
 *  platform: elsewhere they mean a file or directory this process may not
 *  replace, where the in-place write fails the same way and rejects. */
async function replaceFile(filePath: string, contents: string): Promise<void> {
  // Beside the target, so the rename never crosses a filesystem; unique, so no
  // two writers (another path's chain, another process) ever share one.
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    // Flushed, so the rename can't reach the disk before the data does and
    // leave a power cut with a renamed but empty file.
    await writeFile(tempPath, contents, { flush: true });
    const refusedWith = await renameOver(tempPath, filePath);
    if (refusedWith === null) return;
    logger.warn(`prefs: could not rename over ${basename(filePath)} (${refusedWith}); writing it in place`);
    await writeFile(filePath, contents);
  } finally {
    // Already gone after a rename. Best effort otherwise: a temp file something
    // still holds stays behind, and nothing reads it.
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
