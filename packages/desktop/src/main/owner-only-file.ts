import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Tighten an existing secret file to owner-only (0o600). A no-op when the
 *  file is missing; Windows ignores POSIX modes (the directory's ACLs apply).
 *  Best effort — never throws — so a caller reading a secret can't mistake a
 *  failed chmod for a missing file and regenerate (and lose) the secret. */
export function tightenToOwnerOnly(path: string): void {
  try {
    if (existsSync(path)) chmodSync(path, 0o600);
  } catch {
    // Left as is: the read still returns the secret, and the next write's
    // strict chmod reports a real problem.
  }
}

/** Write a secret only the current user can read. writeFileSync's `mode`
 *  applies only when it CREATES the file, so an existing file (one loosened
 *  outside the app — a restore, a copy under umask 022) is tightened before
 *  the new secret goes in, and once more after in case it was created in
 *  between. */
export function writeOwnerOnlyFileSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  tightenToOwnerOnly(path);
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}
