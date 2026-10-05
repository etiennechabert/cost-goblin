// merge-update-manifests.mjs builds the latest-mac.yml / latest.yml that
// electron-updater reads, and only release.yml runs it, so a regression here
// would surface as a broken auto-update after a tag. Runs the real script on
// temp manifests.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../.github/scripts/merge-update-manifests.mjs', import.meta.url));

// The single-arch shape electron-builder writes: top-level path/sha512 mirror
// the one files entry. (The mac x64 zip carries no arch token.)
const manifest = (zip) => ({
  version: '1.2.3',
  files: [{ url: zip, sha512: `sha-${zip}`, size: 1 }],
  path: zip,
  sha512: `sha-${zip}`,
  releaseDate: '2026-10-04T00:00:00.000Z',
});

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merge-manifests-'));
  writeFileSync(join(dir, 'x64.yml'), yaml.dump(manifest('CostGoblin-1.2.3-mac.zip')));
  writeFileSync(join(dir, 'arm64.yml'), yaml.dump(manifest('CostGoblin-1.2.3-arm64-mac.zip')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
const readOut = () => yaml.load(readFileSync(join(dir, 'out.yml'), 'utf8'));

describe('merge-update-manifests', () => {
  it('merges every arch, x64 first, without a minimum OS version by default', () => {
    const res = run(join(dir, 'out.yml'), join(dir, 'x64.yml'), join(dir, 'arm64.yml'));
    expect(res.status).toBe(0);
    const out = readOut();
    expect(out.files.map((f) => f.url)).toEqual(['CostGoblin-1.2.3-mac.zip', 'CostGoblin-1.2.3-arm64-mac.zip']);
    expect(out.version).toBe('1.2.3');
    expect(out).not.toHaveProperty('minimumSystemVersion');
  });

  it('writes --minimum-system-version into the merged manifest', () => {
    // electron-updater skips the update when semver.lt(os.release(), this).
    const res = run('--minimum-system-version', '22.0.0', join(dir, 'out.yml'), join(dir, 'x64.yml'), join(dir, 'arm64.yml'));
    expect(res.status).toBe(0);
    const out = readOut();
    expect(out.minimumSystemVersion).toBe('22.0.0');
    expect(out.files).toHaveLength(2);
  });

  it.each([['13'], ['13.0'], ['v22.0.0'], ['022.0.0'], ['22.00.0'], ['']])('rejects a non-semver minimum OS version %j', (value) => {
    // os.release() is compared with semver.lt; anything else makes electron-updater
    // log a warning and offer the update anyway, which is exactly what the flag is for.
    const res = run('--minimum-system-version', value, join(dir, 'out.yml'), join(dir, 'x64.yml'), join(dir, 'arm64.yml'));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/minimum-system-version/);
  });

  it('still requires an output and at least two manifests after the flag', () => {
    const res = run('--minimum-system-version', '22.0.0', join(dir, 'out.yml'), join(dir, 'x64.yml'));
    expect(res.status).not.toBe(0);
    expect(res.stderr).toMatch(/usage/);
  });
});

// release.yml hard-codes the macOS floor it publishes, and Electron majors land
// through Dependabot like any other bump, so nothing else would notice when one
// raises its macOS minimum: the next update would install on Macs it can't
// launch on. When this fails on an Electron major, read that major's
// docs/breaking-changes.md for a "Removed: macOS N support" entry, raise
// --minimum-system-version in release.yml to N's Darwin version if so (macOS
// 13 = 22, 14 = 23, 15 = 24, 26 = 25), then record both here.
const REVIEWED_MAC_FLOOR = { electronMajor: 44, darwin: '22.0.0' };

describe('release.yml macOS update floor', () => {
  it('was reviewed for the Electron major the lockfile ships', () => {
    const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    const electron = lock.packages['node_modules/electron'].version;
    expect(Number(electron.split('.')[0])).toBe(REVIEWED_MAC_FLOOR.electronMajor);

    const release = readFileSync(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
    const flag = /merge-update-manifests\.mjs --minimum-system-version (\S+) upload\/latest-mac\.yml/.exec(release);
    expect(flag?.[1]).toBe(REVIEWED_MAC_FLOOR.darwin);
  });
});
