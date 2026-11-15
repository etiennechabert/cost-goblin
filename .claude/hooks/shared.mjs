// Shared by the hooks of this directory: how a hook is started and reads its
// input, git asked about a directory, and the `owner/name` of a GitHub
// repository out of a remote URL.

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** Standard input, whole. Read as a stream: `readFileSync(0)` throws EAGAIN on a pipe that is non-blocking and still empty. */
export async function readStdin() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * True when Node was started on the module with this `import.meta.url`. Both
 * paths are resolved first: Node gives `import.meta.url` the real path, so
 * behind a symlinked directory a plain comparison with `process.argv[1]`
 * fails, and the hook would exit having checked nothing.
 */
export function startedDirectly(moduleUrl) {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
