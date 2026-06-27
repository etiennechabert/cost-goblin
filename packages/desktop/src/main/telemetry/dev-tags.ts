/**
 * Dev-only Sentry tags so locally-run builds can be told apart by git branch
 * and commit. Production (packaged) builds aren't a source checkout — they carry
 * a `release` version instead and get no branch/commit. Kept electron-free
 * (`isPackaged` / repo dir are passed in) so the parsing is unit-testable.
 */

/** Assemble the tag set from raw `git rev-parse` output. A detached HEAD
 *  ('HEAD') or empty value is dropped; whitespace is trimmed. Pure. */
export function buildDevTags(branch: string | null, commit: string | null): Record<string, string> {
  const tags: Record<string, string> = {};
  const b = branch?.trim();
  if (b !== undefined && b !== '' && b !== 'HEAD') tags['branch'] = b;
  const c = commit?.trim();
  if (c !== undefined && c !== '') tags['commit'] = c;
  return tags;
}

async function gitOut(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const { stdout } = await run('git', [...args], { cwd, timeout: 2000 });
    return stdout;
  } catch {
    return null;
  }
}

/** Resolve `{ branch, commit }` for a dev checkout. No-op (`{}`) for packaged
 *  builds, and fail-safe: any git error yields no tags rather than throwing. */
export async function readDevTags(isPackaged: boolean, repoDir: string): Promise<Record<string, string>> {
  if (isPackaged) return {};
  const [branch, commit] = await Promise.all([
    gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir),
    gitOut(['rev-parse', '--short', 'HEAD'], repoDir),
  ]);
  return buildDevTags(branch, commit);
}
