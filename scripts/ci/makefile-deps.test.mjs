// The Makefile's `deps` target reinstalls node_modules whenever package-lock.json
// differs from the one last installed. Without it, a pull that moved a
// dependency left `make dev` / `make prod` running against the old install:
// TanStack Table 9 (#667) made `make prod` fail to bundle and `make dev` open a
// black window in a checkout last installed before it.
//
// Runs the real Makefile against a fake `npm` placed first on PATH, in a temp
// directory, so no install ever happens.

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const makefile = fileURLToPath(new URL('../../Makefile', import.meta.url));
const desktopManifest = fileURLToPath(new URL('../../packages/desktop/package.json', import.meta.url));
const STAMP = join('node_modules', '.installed-package-lock.json');

// `npm ci` deletes node_modules and installs it afresh. It can fail before
// touching node_modules (lockfile or engine validation: FAKE_NPM_FAIL=early)
// or after deleting it (FAKE_NPM_FAIL=late). Each call is appended to
// $FAKE_NPM_LOG.
const FAKE_NPM = `#!/usr/bin/env bash
set -eu
echo "$*" >> "$FAKE_NPM_LOG"
if [ "\${1:-}" = "ci" ]; then
  if [ "\${FAKE_NPM_FAIL:-}" = "early" ]; then exit 1; fi
  rm -rf node_modules
  if [ "\${FAKE_NPM_FAIL:-}" = "late" ]; then exit 1; fi
  mkdir node_modules
  exit 0
fi
echo "fake npm: unexpected args: $*" >&2
exit 2
`;

const hasMake = spawnSync('make', ['--version']).status === 0;

/**
 * Parses `target: prereqs ## help` lines and their tab-indented recipes, with
 * `$(VAR)` references expanded from the file's `VAR = value` assignments, so a
 * command hidden behind a variable (like `$(BUILD)`) is still seen.
 */
function parseTargets(source) {
  const vars = new Map();
  const targets = new Map();
  let current = null;
  for (const line of source.split('\n')) {
    const header = /^([a-zA-Z0-9_-]+):(?!=)([^#]*)/.exec(line);
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*[:?+]?=\s*(.*)$/.exec(line);
    if (header !== null) {
      current = { prereqs: header[2].trim().split(/\s+/).filter(Boolean), recipe: [] };
      targets.set(header[1], current);
    } else if (line.startsWith('\t') && current !== null) {
      current.recipe.push(line.trim());
    } else if (line.trim() !== '' && !line.startsWith('#')) {
      if (assignment !== null) vars.set(assignment[1], assignment[2]);
      current = null;
    }
  }
  const expand = (text) => {
    let out = text;
    for (let depth = 0; depth < 5; depth++) {
      const next = out.replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (ref, name) => vars.get(name) ?? ref);
      if (next === out) break;
      out = next;
    }
    return out;
  };
  for (const target of targets.values()) target.recipe = target.recipe.map(expand);
  return targets;
}

describe.skipIf(!hasMake)('make deps', () => {
  let dir = '';
  let log = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'make-deps-'));
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), FAKE_NPM);
    chmodSync(join(bin, 'npm'), 0o755);
    log = join(dir, 'npm.log');
    writeFileSync(log, '');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"1.0.0"}}}\n');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function make(env = {}) {
    // Drop the variables GNU make reads from its environment: under `make test`,
    // or from a developer's shell, they would leak a parent's flags (a
    // jobserver, `-n`) or extra makefiles into this child make.
    const { MAKEFLAGS: _f, MFLAGS: _m, GNUMAKEFLAGS: _g, MAKEFILES: _x, MAKELEVEL: _l, ...inherited } = process.env;
    const result = spawnSync('make', ['--no-print-directory', '-f', makefile, 'deps'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...inherited, ...env, FAKE_NPM_LOG: log, PATH: `${join(dir, 'bin')}${delimiter}${process.env.PATH ?? ''}` },
    });
    return { status: result.status, out: `${result.stdout}${result.stderr}` };
  }

  const npmCalls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const stamp = () => join(dir, STAMP);

  it('runs npm ci in a checkout with no node_modules and records the installed lockfile', () => {
    const { status, out } = make();
    expect(status).toBe(0);
    expect(out).toContain('package-lock.json differs from the last install');
    expect(npmCalls()).toEqual(['ci']);
    expect(readFileSync(stamp(), 'utf8')).toBe(readFileSync(join(dir, 'package-lock.json'), 'utf8'));
  });

  it('runs npm ci when node_modules predates the stamp (installed before this target existed)', () => {
    mkdirSync(join(dir, 'node_modules'));
    expect(make().status).toBe(0);
    expect(npmCalls()).toEqual(['ci']);
  });

  it('does nothing, silently, when package-lock.json matches the last install', () => {
    make();
    expect(make()).toEqual({ status: 0, out: '' });
    expect(npmCalls()).toEqual(['ci']);
  });

  it('reinstalls once package-lock.json changes, e.g. after a pull that bumps a dependency', () => {
    make();
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"2.0.0"}}}\n');
    expect(make().status).toBe(0);
    expect(npmCalls()).toEqual(['ci', 'ci']);
  });

  it('ignores a newer mtime on an unchanged lockfile, which every checkout or merge leaves', () => {
    make();
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'package-lock.json'), future, future);
    expect(make().status).toBe(0);
    expect(npmCalls()).toEqual(['ci']);
  });

  it('fails the target and leaves no stamp when npm ci fails, so the next run retries', () => {
    const failed = make({ FAKE_NPM_FAIL: 'late' });
    expect(failed.status).not.toBe(0);
    expect(existsSync(stamp())).toBe(false);

    expect(make().status).toBe(0);
    expect(npmCalls()).toEqual(['ci', 'ci']);
  });

  it('keeps the previous stamp when a reinstall fails before touching node_modules', () => {
    make();
    const installed = readFileSync(join(dir, 'package-lock.json'), 'utf8');
    writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{"node_modules/a":{"version":"2.0.0"}}}\n');

    expect(make({ FAKE_NPM_FAIL: 'early' }).status).not.toBe(0);
    // node_modules survived, but it still holds the old tree: the stamp must
    // keep saying so, or the next run would skip the reinstall.
    expect(readFileSync(stamp(), 'utf8')).toBe(installed);

    expect(make().status).toBe(0);
    expect(npmCalls()).toEqual(['ci', 'ci', 'ci']);
  });
});

describe('Makefile targets', () => {
  const targets = parseTargets(readFileSync(makefile, 'utf8'));

  it('makes every target that runs npm or npx depend on deps', () => {
    const usesNodeModules = (recipe) => recipe.some((line) => /\bnp[mx]\b/.test(line));
    const missing = [...targets]
      .filter(([name, { recipe }]) => name !== 'deps' && usesNodeModules(recipe))
      .filter(([, { prereqs }]) => !prereqs.includes('deps'))
      .map(([name]) => name);
    expect(targets.size).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  });

  it('launches prod from the desktop package directory so it shares the dev userData folder', () => {
    // Electron names the app from the package.json it is launched from; given a
    // bare main.js it falls back to "Electron" and opens an empty data folder.
    const recipe = targets.get('prod')?.recipe ?? [];
    expect(recipe).toEqual(['npm run build --workspace=packages/desktop', 'npx electron packages/desktop']);
    // ...and that package's entry point is the bundle the build step just wrote.
    expect(JSON.parse(readFileSync(desktopManifest, 'utf8')).main).toBe('out/main/main.js');
  });
});
