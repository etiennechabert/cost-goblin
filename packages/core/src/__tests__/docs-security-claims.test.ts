import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Approvers read the README, costgoblin.com and the exporter docs to decide
// which laptop controls to require. These guard against claims that were false
// and must not creep back: at-rest "vault" encryption (removed in #271; local
// data is plaintext), "never holds credentials that can reach BigQuery" (the
// default gcloud sign-in acts with all of the user's permissions), and
// automatic update installs (download and install each take a click, so an
// approver must not skip MDM patching on the strength of the docs).

const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');

/** Reads a repo file with every whitespace run collapsed to one space, so a
 *  phrase wrapped across lines (Markdown/HTML) still matches. */
function readCollapsed(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf-8').replaceAll(/\s+/g, ' ');
}

const DOCS = ['README.md', 'SPEC.md', 'scripts/gcp-focus-exporter/README.md', 'docs/index.html'];

const FORBIDDEN: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'claims no credential can reach BigQuery', pattern: /(never holds|holds no) credentials? that can reach/i },
  { label: 'advertises at-rest encryption', pattern: /AES-256|vault encryption|keychain integration/i },
  { label: 'points at the stale pre-workspace dev data path', pattern: /@costgoblin\/desktop\/data\/raw/ },
  {
    label: 'claims updates install automatically or silently',
    pattern: /installs? (them|updates?) automatically|auto-?updates when|silent background update/i,
  },
];

describe('security claims in the docs', () => {
  for (const doc of DOCS) {
    for (const { label, pattern } of FORBIDDEN) {
      it(`${doc} never ${label}`, () => {
        // Compare the match itself, so a failure names the offending phrase
        // instead of dumping the whole document.
        expect(pattern.exec(readCollapsed(doc))?.[0]).toBeUndefined();
      });
    }
  }

  it('README documents the launch update check and how to turn it off', () => {
    const readme = readCollapsed('README.md');
    expect(readme).toMatch(/check GitHub Releases/i);
    expect(readme).toMatch(/COSTGOBLIN_DISABLE_UPDATE_CHECK=1/);
    expect(readme).toMatch(/launchctl setenv/);
  });

  it('README states that local data is stored unencrypted and relies on full-disk encryption', () => {
    const readme = readCollapsed('README.md');
    expect(readme).toMatch(/stored unencrypted/i);
    expect(readme).toMatch(/full-disk encryption/i);
  });
});
