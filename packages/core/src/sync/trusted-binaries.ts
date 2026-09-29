import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';

/**
 * The single home of the "which directories may supply binaries" decision.
 *
 * Every external CLI the app shells out to — aws (credential-handling SSO
 * login + S3 sync), gcloud (ADC login + storage rsync), git and gh (dev-only
 * telemetry/debug tags) — is resolved here from a fixed list of absolute
 * install locations. The inherited PATH is never consulted: PATH resolution
 * lets a writable early PATH entry substitute the binary (Sonar S4036), which
 * for `aws sso login` and `gcloud auth login` means substituting the process
 * that handles live credentials.
 *
 * One module owns the lists because hand-written copies have already drifted
 * in this codebase: the gcloud sign-in handler once carried its own list that
 * omitted every Windows location, so sync found gcloud and the re-auth button
 * did not.
 *
 * Contract: a miss returns null and the caller disables or reports the
 * feature ("CLI not found") — it must never fall back to a bare-name spawn.
 *
 * Resolution is deliberately uncached: every call re-probes the candidate
 * list, so installing, uninstalling, or relocating a CLI takes effect on the
 * next click with no app restart. The probe is a handful of existsSync calls
 * against paths whose very next use is spawning a process — caching here
 * previously bought staleness bugs (a relocated CLI wedged "not found" until
 * restart; on Windows a stale hit made the re-auth button a silent no-op),
 * not measurable speed.
 */

/** First candidate that exists on disk, or null when the binary is not
 *  installed in any trusted location. Candidates must be absolute — a
 *  relative entry would probe relative to whatever CWD the app was launched
 *  from, which is exactly the untrusted-directory lookup this module exists
 *  to prevent. (The candidate builders below only emit absolute paths; this
 *  guard is defense in depth.) */
export function findTrustedBinary(platformCandidates: readonly string[]): string | null {
  for (const candidate of platformCandidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    return candidate;
  }
  return null;
}

/** A set-but-empty Windows env var must behave like an unset one — feeding
 *  '' to join() would build a relative candidate that the isAbsolute guard
 *  then drops, disabling resolution despite a default-location install. */
function nonEmptyEnv(name: string): string | null {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

function programFiles(): string {
  return nonEmptyEnv('PROGRAMFILES') ?? String.raw`C:\Program Files`;
}

/** Locations the AWS CLI installs to, most-specific first. Includes the
 *  documented non-root target (`./aws/install -b ~/.local/bin`) and the
 *  snap channel — both root-of-trust equivalents of the system dirs (snapd
 *  populates /snap/bin, and a user's own home is theirs by definition on
 *  this single-user desktop app). */
export function awsCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [join(programFiles(), 'Amazon', 'AWSCLIV2', 'aws.exe')]
    : [
        '/opt/homebrew/bin/aws',
        '/usr/local/bin/aws',
        '/usr/bin/aws',
        '/usr/local/sbin/aws',
        '/opt/local/bin/aws',
        '/snap/bin/aws',
        join(homedir(), '.local', 'bin', 'aws'),
      ];
}

export function findAwsCli(): string | null {
  return findTrustedBinary(awsCliCandidates());
}

/** Locations the Cloud SDK installs to, most-specific first. */
export function gcloudCliCandidates(): readonly string[] {
  if (process.platform === 'win32') {
    const localAppData = nonEmptyEnv('LOCALAPPDATA');
    return [
      join(programFiles(), 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
      ...(localAppData === null
        ? []
        : [join(localAppData, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd')]),
    ];
  }
  return [
    '/opt/homebrew/bin/gcloud',
    '/usr/local/bin/gcloud',
    '/usr/bin/gcloud',
    '/opt/local/bin/gcloud',
    '/snap/bin/gcloud',
    join(homedir(), 'google-cloud-sdk', 'bin', 'gcloud'),
  ];
}

export function findGcloudCli(): string | null {
  return findTrustedBinary(gcloudCliCandidates());
}

/** The directories of `gcloudCliCandidates`, deduped. Used only to build the
 *  PATH handed to a spawned gcloud (`gcloudChildPath`) — the gcloud binary
 *  itself is always spawned by the absolute path `findGcloudCli` returned,
 *  never resolved from PATH. */
export function gcloudSearchPaths(): string[] {
  return [...new Set(gcloudCliCandidates().filter(p => isAbsolute(p)).map(p => dirname(p)))];
}

/** PATH for a spawned gcloud child, trusted SDK directories FIRST. The
 *  launcher script resolves its own helpers (python3, bundled components)
 *  from PATH — with the inherited entries first, a writable early PATH entry
 *  could supply the interpreter that then runs the whole credential flow,
 *  the same substitution class this module closes for the binary itself.
 *  Empty segments are dropped: they mean "current directory" to PATH lookup. */
export function gcloudChildPath(inheritedPath: string): string {
  const inherited = inheritedPath.split(delimiter).filter(p => p !== '');
  return [...new Set([...gcloudSearchPaths(), ...inherited])].join(delimiter);
}

/** Characters cmd.exe cannot contain inside a `"…"` token, with the name each
 *  is reported under: `"` ends the quote (so a following `&` starts a new
 *  command), `%VAR%` expands even inside quotes, `!VAR!` expands when delayed
 *  expansion is enabled in the registry (`/d` does not stop it), CR/LF end
 *  the command line, and NUL truncates it. There is no safe escape for `%` on
 *  a command line, so an arg carrying any of them is refused, never escaped. */
const CMD_UNQUOTABLE: ReadonlyMap<string, string> = new Map([
  ['"', '"'],
  ['%', '%'],
  ['!', '!'],
  ['\r', 'CR'],
  ['\n', 'LF'],
  ['\0', 'NUL'],
]);

/** Names of the `CMD_UNQUOTABLE` characters in `arg`, deduped, in order of
 *  first appearance; empty when the arg is safe to quote. */
function unquotableChars(arg: string): string[] {
  const found = new Set<string>();
  for (const ch of arg) {
    const name = CMD_UNQUOTABLE.get(ch);
    if (name !== undefined) found.add(name);
  }
  return [...found];
}

/** Spawn shape for a resolved gcloud path. Windows ships gcloud as
 *  `gcloud.cmd`, which Node refuses to spawn without a shell since
 *  CVE-2024-27980 — so under cmd.exe the binary and every argument are
 *  quoted. Quoting alone is not enough: on win32 this function THROWS for
 *  any arg containing `"`, `%`, `!`, CR, LF or NUL (`CMD_UNQUOTABLE`), and
 *  that assertion is the guarantee every caller relies on. Callers still
 *  validate their inputs first — the rsync source's bucket via
 *  `isValidGcsBucketName`, its period prefix via `isSafePeriodPrefix`,
 *  impersonation targets via the config-load email check — but the
 *  assertion also covers args nobody validates, such as a staging path under
 *  a data directory whose name contains `%` or `!`. POSIX spawns the binary
 *  directly with an argv array, so no shell parses the args and they pass
 *  through unchanged. One home for the recipe so the three gcloud spawn sites
 *  cannot drift on it. */
export function gcloudSpawnShape(
  bin: string,
  args: readonly string[],
): { readonly command: string; readonly args: string[]; readonly shell: boolean } {
  const shell = process.platform === 'win32';
  if (!shell) return { command: bin, args: [...args], shell };
  for (const arg of args) {
    const refused = unquotableChars(arg);
    if (refused.length > 0) {
      throw new Error(
        `An argument cannot be passed to gcloud on Windows: it contains ${refused.join(' ')}, `
        + 'which cmd.exe cannot quote safely. A Windows data directory whose path contains % or ! '
        + '(the profile folder, or COSTGOBLIN_DATA_DIR) cannot be used for GCP sync.',
      );
    }
  }
  return { command: `"${bin}"`, args: args.map(a => `"${a}"`), shell };
}

/** Locations git installs to. Git for Windows puts the shim in `Git\cmd`
 *  under either Program Files; it has never shipped in System32. */
export function gitCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [
        join(programFiles(), 'Git', 'cmd', 'git.exe'),
        join(nonEmptyEnv('ProgramFiles(x86)') ?? String.raw`C:\Program Files (x86)`, 'Git', 'cmd', 'git.exe'),
      ]
    : ['/usr/bin/git', '/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git', '/opt/local/bin/git'];
}

export function findGitCli(): string | null {
  return findTrustedBinary(gitCliCandidates());
}

/** Locations the GitHub CLI installs to. No snap entry on purpose: the gh
 *  snap is community-maintained and GitHub's docs steer users away from it. */
export function ghCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [join(programFiles(), 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/opt/local/bin/gh'];
}

export function findGhCli(): string | null {
  return findTrustedBinary(ghCliCandidates());
}
