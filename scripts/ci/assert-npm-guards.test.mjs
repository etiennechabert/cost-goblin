// Exercises .github/scripts/assert-npm-guards.sh against a fake `npm` placed
// first on PATH, so every npm the workflows might meet can be simulated without
// installing it. The case that matters most is an npm too old to know a guard:
// `npm config get <unknown key>` still prints the .npmrc value on stdout and
// only warns on stderr, which is exactly what made the previous ci.yml check
// inert (#596, VULN-021).

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../.github/scripts/assert-npm-guards.sh', import.meta.url));

// Answers `npm --version` and `npm config get <key>` from FAKE_NPM_* env vars.
// Keys listed in FAKE_NPM_UNKNOWN get npm's unknown-config warning on stderr,
// while their value is still echoed on stdout — the real npm's behaviour.
const FAKE_NPM = `#!/usr/bin/env bash
set -eu
if [ "\${1:-}" = "--version" ]; then
  echo "$FAKE_NPM_VERSION"
  exit 0
fi
if [ "\${1:-}" = "config" ] && [ "\${2:-}" = "get" ]; then
  key="\${3:-}"
  case " \${FAKE_NPM_UNKNOWN:-} " in
    *" $key "*) echo "npm warn Unknown project config \\"$key\\". This will stop working in the next major version of npm." >&2 ;;
  esac
  case "$key" in
    strict-allow-scripts) echo "$FAKE_NPM_STRICT_ALLOW_SCRIPTS" ;;
    min-release-age) echo "$FAKE_NPM_MIN_RELEASE_AGE" ;;
    engine-strict) echo "$FAKE_NPM_ENGINE_STRICT" ;;
    *) echo "undefined" ;;
  esac
  exit 0
fi
echo "fake npm: unexpected args: $*" >&2
exit 2
`;

const VALID = {
  FAKE_NPM_VERSION: '11.16.0',
  FAKE_NPM_STRICT_ALLOW_SCRIPTS: 'true',
  FAKE_NPM_MIN_RELEASE_AGE: '7',
  FAKE_NPM_ENGINE_STRICT: 'true',
  FAKE_NPM_UNKNOWN: '',
};

let fakeBin = '';

beforeAll(() => {
  fakeBin = mkdtempSync(join(tmpdir(), 'fake-npm-'));
  const npm = join(fakeBin, 'npm');
  writeFileSync(npm, FAKE_NPM);
  chmodSync(npm, 0o755);
});

afterAll(() => {
  rmSync(fakeBin, { recursive: true, force: true });
});

function run(overrides = {}) {
  const result = spawnSync('bash', [script], {
    encoding: 'utf8',
    // Fake npm first; the rest of PATH is kept so the script's `node -e` works.
    env: { ...process.env, ...VALID, ...overrides, PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}` },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe('assert-npm-guards.sh', () => {
  it('passes with a guard-aware npm and every guard set', () => {
    const { status, out } = run();
    expect(status).toBe(0);
    expect(out).toMatch(/^OK: npm 11\.16\.0/m);
    expect(out).not.toContain('::error::');
  });

  it('passes on a newer npm', () => {
    expect(run({ FAKE_NPM_VERSION: '11.19.0' }).status).toBe(0);
    expect(run({ FAKE_NPM_VERSION: '12.0.0' }).status).toBe(0);
  });

  it('fails on npm 11.14 that echoes the .npmrc value but warns the key is unknown', () => {
    // The blind spot of the old check: stdout says `true`, only stderr knows better.
    const { status, out } = run({ FAKE_NPM_VERSION: '11.14.0', FAKE_NPM_UNKNOWN: 'strict-allow-scripts' });
    expect(status).not.toBe(0);
    expect(out).toContain('::error::');
  });

  it('fails on an npm older than 11.16.0 even without a warning', () => {
    for (const version of ['11.15.9', '10.9.2', '9.0.0']) {
      expect(run({ FAKE_NPM_VERSION: version }).status).not.toBe(0);
    }
  });

  it.each(['strict-allow-scripts', 'min-release-age', 'engine-strict'])(
    'fails when a guard-aware npm still warns that %s is unknown',
    (key) => {
      const { status, out } = run({ FAKE_NPM_UNKNOWN: key });
      expect(status).not.toBe(0);
      expect(out).toContain(`::error::`);
      expect(out).toContain(key);
    },
  );

  it('fails when strict-allow-scripts is not true', () => {
    expect(run({ FAKE_NPM_STRICT_ALLOW_SCRIPTS: 'false' }).status).not.toBe(0);
    expect(run({ FAKE_NPM_STRICT_ALLOW_SCRIPTS: 'undefined' }).status).not.toBe(0);
  });

  it('fails when engine-strict is not true', () => {
    expect(run({ FAKE_NPM_ENGINE_STRICT: 'false' }).status).not.toBe(0);
  });

  it.each(['0', '-1', 'undefined', '', '7d', '1.5'])('fails when min-release-age is %j', (age) => {
    expect(run({ FAKE_NPM_MIN_RELEASE_AGE: age }).status).not.toBe(0);
  });

  it('fails on an unparsable npm version', () => {
    expect(run({ FAKE_NPM_VERSION: 'not-a-version' }).status).not.toBe(0);
  });
});
