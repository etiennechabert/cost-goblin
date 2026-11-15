// Shared by the hooks of this directory: git asked about a directory, and the
// `owner/name` of a GitHub repository out of a remote URL.

import { spawnSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 2_000;

let gitEnvironment;
/**
 * The environment without the variables that tie git to one repository
 * (GIT_DIR and the like, which git lists itself). A git hook exports them,
 * and under them every directory would look like that hook's repository.
 */
function gitEnv() {
  if (gitEnvironment === undefined) {
    gitEnvironment = { ...process.env };
    const listed = spawnSync('git', ['rev-parse', '--local-env-vars'], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
    if (listed.status === 0) for (const name of listed.stdout.split('\n')) delete gitEnvironment[name];
  }
  return gitEnvironment;
}

/** What `git -C dir …` prints, trimmed, or null when git fails. Only for commands that read. */
export function runGit(dir, args) {
  const result = spawnSync('git', ['-C', dir, ...args], { env: gitEnv(), encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** `owner/name`, lowercased, out of a remote URL or of gh's `[HOST/]OWNER/REPO`. Null when it has no such shape. */
export function slugOf(text) {
  const match = /([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(text.trim());
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}
