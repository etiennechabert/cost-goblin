#!/usr/bin/env bash
# Assert the .npmrc supply-chain guards are ACTIVE before any `npm ci` runs.
#
# Every guard fails OPEN on an npm that doesn't know it: npm emits one
# `npm warn Unknown project config "<key>"` line on stderr and installs with no
# protection. Worse, `npm config get <unknown key>` still prints the .npmrc value
# on stdout, so checking the value alone is inert — the old ci.yml assertion
# passed on npm 11.14 for exactly that reason. This script therefore checks:
#   1. npm >= 11.16.0 (the first release that knows strict-allow-scripts);
#   2. npm does not warn that any guard key is unknown;
#   3. strict-allow-scripts and engine-strict are `true`;
#   4. min-release-age is an integer >= 1.
#
# Called from ci.yml (security-audit) and from every release.yml job that runs
# `npm ci`. Tested by scripts/ci/assert-npm-guards.test.mjs with a fake npm.
set -euo pipefail

# `npm config get` reads the project .npmrc from the nearest package.json dir,
# so run from the repo root no matter where the caller's cwd is.
cd "$(dirname "$0")/../.."

MIN_NPM=11.16.0
GUARDS="strict-allow-scripts min-release-age engine-strict"

fail=0
err() {
  echo "::error::$1"
  fail=1
}

npm_v=$(npm --version)
if ! node -e '
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
    return m ? m.slice(1, 4).map(Number) : null;
  };
  const [have, want] = [parse(process.argv[1]), parse(process.argv[2])];
  if (!have || !want) process.exit(2);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== want[i]) process.exit(have[i] > want[i] ? 0 : 1);
  }
' "$npm_v" "$MIN_NPM"; then
  err "npm $npm_v is older than $MIN_NPM (or unparsable): the .npmrc guards are silently inert. Use Node >= 24.18 (nvm install 24)."
fi

for key in $GUARDS; do
  if ! warn=$(npm config get "$key" 2>&1 >/dev/null); then
    err "\`npm config get $key\` failed: $warn"
    continue
  fi
  if printf '%s' "$warn" | grep -qF "Unknown project config \"$key\""; then
    err "npm $npm_v does not recognise '$key' — that .npmrc guard is silently inert."
  fi
done

strict_scripts=$(npm config get strict-allow-scripts 2>/dev/null)
engine_strict=$(npm config get engine-strict 2>/dev/null)
min_age=$(npm config get min-release-age 2>/dev/null)

if [ "$strict_scripts" != "true" ]; then
  err "strict-allow-scripts is '$strict_scripts', expected 'true' — dependency install scripts would run unreviewed."
fi
if [ "$engine_strict" != "true" ]; then
  err "engine-strict is '$engine_strict', expected 'true' — an npm below package.json#engines could install."
fi
if ! [[ "$min_age" =~ ^[0-9]+$ ]] || [ "$((10#$min_age))" -lt 1 ]; then
  err "min-release-age is '$min_age', expected an integer >= 1 (days)."
fi

[ "$fail" = 0 ] || exit 1
echo "OK: npm $npm_v, strict-allow-scripts=$strict_scripts, engine-strict=$engine_strict, min-release-age=$min_age"
