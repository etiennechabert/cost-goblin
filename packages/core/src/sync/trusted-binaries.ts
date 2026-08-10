import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

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
 */

/** Absolute path of each binary already located, keyed by binary name. Only
 *  hits are cached: a user who sees "CLI not found", installs it, and retries
 *  must succeed without restarting the app. */
const resolved = new Map<string, string>();

/** First candidate that exists on disk, or null when the binary is not
 *  installed in any trusted location. Candidates must be absolute — a
 *  relative entry (e.g. `join('', ...)` when a Windows env var is unset)
 *  would probe relative to whatever CWD the app was launched from, which is
 *  exactly the untrusted-directory lookup this module exists to prevent. */
export function findTrustedBinary(name: string, platformCandidates: readonly string[]): string | null {
  const hit = resolved.get(name);
  if (hit !== undefined) return hit;
  for (const candidate of platformCandidates) {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    resolved.set(name, candidate);
    return candidate;
  }
  return null;
}

function programFiles(): string {
  return process.env['PROGRAMFILES'] ?? String.raw`C:\Program Files`;
}

/** Locations the AWS CLI installs to, most-specific first. */
export function awsCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [join(programFiles(), 'Amazon', 'AWSCLIV2', 'aws.exe')]
    : [
        '/opt/homebrew/bin/aws',
        '/usr/local/bin/aws',
        '/usr/bin/aws',
        '/usr/local/sbin/aws',
        '/opt/local/bin/aws',
      ];
}

export function findAwsCli(): string | null {
  return findTrustedBinary('aws', awsCliCandidates());
}

/** Locations the Cloud SDK installs to, most-specific first. */
export function gcloudCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [
        join(programFiles(), 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
        join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'),
      ]
    : [
        '/opt/homebrew/bin/gcloud',
        '/usr/local/bin/gcloud',
        '/usr/bin/gcloud',
        '/opt/local/bin/gcloud',
        join(homedir(), 'google-cloud-sdk', 'bin', 'gcloud'),
      ];
}

export function findGcloudCli(): string | null {
  return findTrustedBinary('gcloud', gcloudCliCandidates());
}

/** The directories of `gcloudCliCandidates`, for augmenting the PATH handed
 *  to a spawned gcloud. This shapes only the child's own helper lookups
 *  (python, bundled components) — the gcloud binary itself is always spawned
 *  by the absolute path `findGcloudCli` returned, never resolved from PATH. */
export function gcloudSearchPaths(): string[] {
  return [...new Set(gcloudCliCandidates().filter(p => isAbsolute(p)).map(p => dirname(p)))];
}

/** Locations git installs to. Git for Windows puts the shim in
 *  `Git\cmd` under either Program Files; it has never shipped in System32. */
export function gitCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [
        join(programFiles(), 'Git', 'cmd', 'git.exe'),
        join(process.env['ProgramFiles(x86)'] ?? String.raw`C:\Program Files (x86)`, 'Git', 'cmd', 'git.exe'),
      ]
    : ['/usr/bin/git', '/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'];
}

export function findGitCli(): string | null {
  return findTrustedBinary('git', gitCliCandidates());
}

/** Locations the GitHub CLI installs to. */
export function ghCliCandidates(): readonly string[] {
  return process.platform === 'win32'
    ? [join(programFiles(), 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
}

export function findGhCli(): string | null {
  return findTrustedBinary('gh', ghCliCandidates());
}
