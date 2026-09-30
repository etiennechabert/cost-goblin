import { randomUUID } from 'node:crypto';
import { chmod, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** True when `err` is a Node system error carrying one of `codes`. */
export function hasErrnoCode(err: unknown, codes: readonly string[]): boolean {
  return err instanceof Error && 'code' in err && typeof err.code === 'string' && codes.includes(err.code);
}

// A Windows antivirus, indexer or backup tool can briefly hold a file or a
// just-written temp file (EPERM/EACCES/EBUSY on open or rename), and a busy
// process can momentarily run out of descriptors (EMFILE). Those are retried
// with backoff; anything else, or one that outlasts the backoff, propagates.
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 800];

export function isTransientFsError(err: unknown): boolean {
  return hasErrnoCode(err, ['EPERM', 'EACCES', 'EBUSY', 'EMFILE']);
}

/** Run `op`, retrying transient lock/descriptor errors once per entry of
 *  `delaysMs` (waiting that long first); the final attempt's error propagates. */
export async function retryTransientFs<T>(
  op: () => Promise<T>,
  delaysMs: readonly number[] = TRANSIENT_RETRY_DELAYS_MS,
): Promise<T> {
  try {
    return await op();
  } catch (err: unknown) {
    const [delayMs, ...rest] = delaysMs;
    if (delayMs === undefined || !isTransientFsError(err)) throw err;
    await sleep(delayMs);
    return retryTransientFs(op, rest);
  }
}

/**
 * Run a local read, retrying transient failures. Resolves null when the path
 * doesn't exist (ENOENT) — the only failure that means "nothing there yet";
 * anything else rejects. A caller that read any other failure as "nothing
 * there" would go on to rebuild or rewrite it from an empty state.
 */
export async function ifExists<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await retryTransientFs(read);
  } catch (err: unknown) {
    if (hasErrnoCode(err, ['ENOENT'])) return null;
    throw err;
  }
}

/** A file's text, or null when it does not exist (see `ifExists`). */
export function readTextIfExists(path: string): Promise<string | null> {
  return ifExists(() => readFile(path, 'utf-8'));
}

// A writer that dies between writing its temp file and renaming it (a crash,
// the app quitting) never reaches its cleanup, and the temp's random name is
// never reused, so sweep them. A live write's temp is milliseconds old: an
// hour is far past anything still in flight.
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

/** Remove `<path>.<id>.tmp` files older than an hour. */
export async function sweepStaleTemps(path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  const names = await readdir(dir).catch((): string[] => []);
  const cutoff = Date.now() - STALE_TEMP_AGE_MS;
  await Promise.all(names
    .filter((name) => name.startsWith(prefix) && name.endsWith('.tmp'))
    .map(async (name) => {
      const tmpPath = join(dir, name);
      const info = await stat(tmpPath).catch(() => null);
      if (info !== null && info.mtimeMs < cutoff) {
        await rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
      }
    }));
}

/**
 * Replace `path` with `data` so that a reader — or the next launch after a
 * crash, a quit mid-write or a power cut — sees either the old contents or the
 * new ones, never a truncated mix. The data is flushed to a uniquely named
 * temp file beside the target (same filesystem, so the rename is atomic; unique,
 * so concurrent writers never share one), then renamed over it. Transient
 * Windows lock errors on either step are retried; on failure the temp is
 * removed and the previous file is left untouched. Like the in-place write it
 * replaces, it writes through a symlink and keeps the file's permissions.
 */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const target = await realpath(path).catch(() => path);
  const mode = await stat(target).then((s) => s.mode & 0o7777, () => null);
  await sweepStaleTemps(target);
  const tmpPath = `${target}.${randomUUID()}.tmp`;
  try {
    // Flushed, so the rename can't reach the disk before the data does and
    // leave a power cut with a renamed but empty file.
    await retryTransientFs(() => writeFile(tmpPath, data, { flush: true }));
    if (mode !== null) await chmod(tmpPath, mode);
    await retryTransientFs(() => rename(tmpPath, target));
  } catch (err: unknown) {
    await rm(tmpPath, { force: true }).catch(() => { /* best effort */ });
    throw err;
  }
}

/**
 * Move an unreadable file aside to `<path>.corrupt-<timestamp>-<id>` so its
 * bytes survive for manual recovery while the caller starts afresh. Returns
 * the new path. Throws (leaving the file in place) if it can't be moved.
 */
export async function quarantineFile(path: string): Promise<string> {
  // No colons: they are not legal in Windows filenames.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${path}.corrupt-${stamp}-${randomUUID().slice(0, 8)}`;
  await retryTransientFs(() => rename(path, target));
  return target;
}
