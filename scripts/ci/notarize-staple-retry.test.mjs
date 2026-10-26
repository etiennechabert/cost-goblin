// Which @electron/notarize the macOS release build runs.
//
// electron-builder notarizes the app by calling notarize() from the
// @electron/notarize that app-builder-lib resolves (notarizeIfProvided in
// app-builder-lib's mac/MacTargetHelper.js). notarize() submits the app with
// `notarytool submit --wait`, then staples the ticket inside promise-retry.
// Through 3.1.1 (app-builder-lib 26.x pins 2.5.0) the staple callback never
// calls promise-retry's `retry`, so `retries: 3` makes a single attempt: one
// dropped connection to Apple after a successful notarization (`xcrun stapler
// staple`, error 68) failed the v0.8.14 and v0.9.2 release builds.
// 3.1.2 (electron/notarize#306) retries the staple, and the root package.json's
// `overrides` force that version under app-builder-lib. These tests fail when
// an electron-builder bump brings an older copy back, and when electron-builder
// asks for a fixed version itself (27.0.0-alpha.13 asks for ^3.1.1), so the
// override is dropped instead of holding app-builder-lib at 3.1.2 from then on.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = new URL('../../', import.meta.url);
const readJson = (path) => JSON.parse(readFileSync(new URL(path, repoRoot), 'utf8'));

const NOTARIZE = '@electron/notarize';
const FIXED = '3.1.2';

const lock = readJson('package-lock.json').packages;
const appBuilderLibs = Object.keys(lock).filter((path) => path.endsWith('node_modules/app-builder-lib'));

// The lockfile entry Node's resolution finds for `name` from the package
// installed at `from`: its own node_modules first, then each enclosing one.
function resolveFrom(from, name) {
  for (let dir = from; ; ) {
    const prefix = dir === '' ? '' : `${dir}/`;
    const candidate = `${prefix}node_modules/${name}`;
    if (Object.hasOwn(lock, candidate)) return candidate;
    if (dir === '') return undefined;
    const parent = dir.lastIndexOf('node_modules/');
    dir = parent === -1 ? '' : dir.slice(0, parent).replace(/\/$/, '');
  }
}

// A release version as [major, minor, patch]; undefined for prereleases and
// anything else.
function release(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return match === null ? undefined : match.slice(1).map(Number);
}

const FIXED_PARTS = release(FIXED);

// Whether [major, minor, patch] `a` comes before `b`.
function precedes(a, b) {
  const differs = a.findIndex((part, i) => part !== b[i]);
  return differs !== -1 && a[differs] < b[differs];
}

function hasStapleRetry(version) {
  const parts = release(version);
  return parts !== undefined && !precedes(parts, FIXED_PARTS);
}

// The first version a ^ or ~ range no longer allows.
function rangeEnd(operator, [major, minor, patch]) {
  if (operator === '~') return [major, minor + 1, 0];
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

// Whether npm could pick a version >= FIXED for a spec app-builder-lib
// declares: an exact version, or a ^, ~ or >= range.
function allowsStapleRetry(spec) {
  const match = /^(\^|~|>=)?\s*(\d+\.\d+\.\d+)$/.exec(spec ?? '');
  if (match === null) return false;
  const [, operator, version] = match;
  if (operator === undefined) return hasStapleRetry(version);
  return operator === '>=' || precedes(FIXED_PARTS, rangeEnd(operator, release(version)));
}

// Whether package.json's overrides pin NOTARIZE anywhere: under app-builder-lib
// as now, at the top level, or under a version-qualified key.
function forcesNotarize(overrides) {
  return Object.entries(overrides ?? {}).some(
    ([key, value]) =>
      key === NOTARIZE ||
      key.startsWith(`${NOTARIZE}@`) ||
      (typeof value === 'object' && value !== null && forcesNotarize(value)),
  );
}

describe('@electron/notarize used by electron-builder', () => {
  it('is a version whose ticket staple retries', () => {
    expect(appBuilderLibs, 'electron-builder (app-builder-lib) is no longer in the lockfile').not.toEqual([]);
    for (const from of appBuilderLibs) {
      const resolved = resolveFrom(from, NOTARIZE);
      const version = resolved === undefined ? undefined : lock[resolved].version;
      expect(
        hasStapleRetry(version),
        `${from} resolves ${NOTARIZE} ${version ?? '(none)'}, not a release >= ${FIXED}: before ${FIXED}, ` +
          `notarize() staples the notarization ticket once with no retry. Force ${FIXED} through ` +
          `package.json's overrides ("app-builder-lib": { "${NOTARIZE}": "${FIXED}" }); the override can be ` +
          `removed once electron-builder itself ships ${NOTARIZE} >= ${FIXED}.`,
      ).toBe(true);
    }
  });

  it('is forced only while electron-builder asks for an older version', () => {
    const asksForFix = forcesNotarize(readJson('package.json').overrides)
      ? appBuilderLibs
          .filter((from) => allowsStapleRetry(lock[from].dependencies?.[NOTARIZE]))
          .map((from) => `${from} asks for ${NOTARIZE} ${lock[from].dependencies[NOTARIZE]}`)
      : [];
    expect(
      asksForFix,
      `electron-builder's own ${NOTARIZE} spec now allows >= ${FIXED}: remove ${NOTARIZE} from package.json's ` +
        'overrides, or it stays pinned at the forced version as electron-builder moves on.',
    ).toEqual([]);
  });
});
