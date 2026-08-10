import { execFileSync } from 'node:child_process';
import { findGitCli } from '@costgoblin/core';

/**
 * Dev-only Sentry tags so locally-run builds can be told apart by git branch
 * and commit. Production (packaged) builds aren't a source checkout — they carry
 * a `release` version instead and get no branch/commit. Kept electron-free
 * (`isPackaged` / repo dir are passed in) so the parsing is unit-testable.
 *
 * Resolution is synchronous because telemetry initialises before Electron's
 * `ready` event, which can only happen on the synchronous startup path.
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

function gitOut(args: readonly string[], cwd: string): string | null {
  // Absolute trusted install only (`findGitCli`) — never the inherited PATH,
  // where a writable early entry could substitute the binary. A dev machine
  // without git in a standard location just gets no tags.
  const git = findGitCli();
  if (git === null) return null;
  try {
    return execFileSync(git, [...args], { cwd, timeout: 2000, encoding: 'utf-8' });
  } catch {
    return null;
  }
}

/** Resolve `{ branch, commit }` for a dev checkout. No-op (`{}`) for packaged
 *  builds, and fail-safe: any git error yields no tags rather than throwing. */
export function readDevTagsSync(isPackaged: boolean, repoDir: string): Record<string, string> {
  if (isPackaged) return {};
  return buildDevTags(
    gitOut(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir),
    gitOut(['rev-parse', '--short', 'HEAD'], repoDir),
  );
}
