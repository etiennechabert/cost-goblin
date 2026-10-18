/** The errno code a failed fs call rejected with (`ENOENT`, `EEXIST`, ...),
 *  or undefined for anything else. */
export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  return typeof err.code === 'string' ? err.code : undefined;
}

/** The file doesn't exist: the only read failure that means "absent". Any
 *  other one (EACCES, EISDIR, EMFILE) is a file that is there but unreadable. */
export function isEnoent(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}
