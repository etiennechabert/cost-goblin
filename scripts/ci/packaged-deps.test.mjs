// What the packaged app can import at runtime.
//
// electron-builder packs only the ROOT package's production dependency closure
// (it runs `npm list --omit dev` from the root; workspace packages' own
// dependencies are not traversed). electron-vite externalizes every entry of
// packages/desktop's `dependencies` from out/main/main.js, so each one must
// also be a root dependency or the installed app throws ERR_MODULE_NOT_FOUND
// the first time it imports it. Dev and e2e runs resolve from the repo's
// node_modules and never notice: #431 shipped a launch crash this way
// (@sentry/electron), and every GCP listing failed in release builds because
// @google-cloud/storage was missing too.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, repoRoot), 'utf8'));

describe('packaged runtime dependencies', () => {
  it('lists every desktop runtime dependency in the root manifest electron-builder packs', () => {
    const root = readJson('package.json').dependencies ?? {};
    const desktop = readJson('packages/desktop/package.json').dependencies ?? {};
    const missing = Object.keys(desktop).filter((name) => !(name in root));
    expect(missing).toEqual([]);
  });

  it('installs a single google-auth-library, shared with @google-cloud/storage', () => {
    // createGcsStorage hands Storage a GoogleAuth / Impersonated from our own
    // import; Storage only uses it as-is when it is `instanceof` ITS copy's
    // GoogleAuth. A second copy (say, a major bump of ours while storage still
    // pins ^9) silently re-wraps it and can drop the Authorization header —
    // with every unit test green, since they mock both SDKs.
    const lock = readJson('package-lock.json').packages;
    const copies = Object.keys(lock).filter((path) => path.endsWith('node_modules/google-auth-library'));
    expect(copies).toEqual(['node_modules/google-auth-library']);
  });
});
