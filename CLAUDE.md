# CostGoblin — Development Instructions

> Read `SPEC.md` for the full product specification. This file tells you HOW to work. The spec tells you WHAT to build.

## Project Overview

CostGoblin is a desktop app (Electron + TypeScript + DuckDB) for cloud cost visibility. It syncs billing data from S3, stores it locally as Parquet, and queries it with DuckDB. See `SPEC.md` for full architecture and features.

## Monorepo Structure

```
costgoblin/
  data/                     # .gitignore'd — real Parquet data for development only
  packages/
    core/                   # @costgoblin/core — pure TypeScript, no framework deps
    desktop/                # Electron shell — imports @costgoblin/core
    ui/                     # @costgoblin/ui — shared React components
    web-backend/            # (Future) server — imports @costgoblin/core
```

**Package dependency rules:**
- `core` has ZERO dependency on `desktop`, `ui`, or any framework
- `ui` depends on `core` (for types only — never imports query/sync logic directly)
- `desktop` depends on `core` and `ui`
- `web-backend` (future) depends on `core` only

## Commands

```bash
# Verify everything — run after EVERY change
npm run check              # tsc --noEmit + eslint + vitest run (~10 seconds)

# Per-package work
cd packages/core && npm run check     # core only
cd packages/ui && npm run check       # UI only (uses mock CostApi)
cd packages/desktop && npm run check  # desktop only
cd packages/desktop && npm run dev    # launch Electron in dev mode with hot reload

# Tests
npx vitest run                        # all tests
npx vitest run packages/core          # core tests only
npx vitest run <specific-file>        # single test file (fastest iteration)

# Fixtures
npx tsx packages/core/src/__fixtures__/generate.ts --profile    # profile real data
npx tsx packages/core/src/__fixtures__/generate.ts --generate   # create synthetic fixtures
npx tsx packages/core/src/__fixtures__/focus-1-2/write-samples.ts  # regenerate the committed AWS/Azure/GCP FOCUS 1.2 samples
```

## Development Workflow

Follow this sequence for EVERY feature:

```
1. Read the relevant SPEC.md section
2. Write types first (interfaces, branded types, discriminated unions)
3. Run: tsc --noEmit → fix type errors
4. Write tests for the expected behavior
5. Run: vitest run <test-file> → see tests fail (red)
6. Write the implementation
7. Run: vitest run <test-file> → see tests pass (green)
8. Run: npm run check → full verification (MUST pass before moving on)
9. If working on UI: npm run dev in desktop/ to visually verify
10. After pushing & opening the PR — close the review loop (see "After pushing"):
    - Ask the user to run `/code-review ultra --fix` (user-triggered & billed — you can't launch it), then apply its fixes and re-run npm run check
    - Address every sentry[bot] review comment on the PR
```

## TypeScript Rules — STRICTLY ENFORCED

**tsconfig base:**
- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- `noImplicitReturns: true`
- `noFallthroughCasesInSwitch: true`

**BANNED — never use these, fix the design instead:**
- `any` type → use `unknown` and narrow, or define a proper type
- `@ts-ignore` and `@ts-expect-error` → fix the type error
- `as` type assertions → use type guards and discriminated unions
- Non-null assertions (`!`) → handle the null case explicitly
- `eslint-disable` comments → no exceptions, no line-level overrides
- `console.log` → use the structured logger

**REQUIRED patterns:**

Branded types for domain concepts:
```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };
type DimensionId = Brand<string, 'DimensionId'>;
type EntityRef = Brand<string, 'EntityRef'>;
type TagValue = Brand<string, 'TagValue'>;
type Dollars = Brand<number, 'Dollars'>;
```

Discriminated unions for all state (no impossible states):
```typescript
// WRONG:
{ isLoading: boolean; error?: Error; data?: CostResult }

// RIGHT:
type QueryState<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: T }
  | { status: 'error'; error: Error }
```

## Linting Rules

- `@typescript-eslint/strict-type-checked` ruleset
- `@typescript-eslint/no-explicit-any`: error
- `@typescript-eslint/no-unsafe-assignment`: error
- `@typescript-eslint/no-non-null-assertion`: error
- `no-console`: error
- Import sorting enforced
- Formatting: Biome (configured once, never debated)

## Testing Approach

### Layer 1: Core Logic (Vitest)
Pure functions: config loader, tag normalizer, alias resolver, org tree traversal, cost math.
No I/O, no DuckDB. Tests run in milliseconds.

### Layer 2: DuckDB Queries (Vitest)
Real DuckDB queries against synthetic fixture Parquet files in `packages/core/src/__fixtures__/synthetic/`.
Shared DuckDB instance created once per test suite. Fixtures are small (~1000 rows), queries complete in milliseconds.
Provider-shape coverage uses the committed FOCUS 1.2 samples in `packages/core/src/__fixtures__/focus-1-2/` (AWS/Azure/GCP native export shapes, materialized to Parquet at test time).

### Layer 3: React Components (Vitest + React Testing Library)
Components tested against `MockCostApi` (implements `CostApi` interface with fixture data).
No Electron, no DuckDB, no file system.

### Layer 4: Electron E2E (Playwright)
Full app launch pinned to fixture data via `COSTGOBLIN_DATA_DIR` / `COSTGOBLIN_CONFIG_DIR` env vars (see `e2e/helpers.ts`).
Slow (seconds). Run before commits, always in CI.

### Fixture Data
- Real company data is in `data/raw/` — NEVER committed (gitignored + pre-commit guard)
- `profile.json` extracted from real data — committed (statistical shape, no PII)
- Synthetic Parquet files generated from profile — committed, deterministic (seeded random)
- Service names are real (not sensitive). Account IDs, tag values, costs are synthetic.
- A second fixture family lives in `packages/core/src/__fixtures__/focus-1-2/`: committed **CSV** samples of each provider's native FOCUS 1.2 export, regenerated with `write-samples.ts` (see Commands) and pinned byte-for-byte by a drift test.

## Git Safety

```gitignore
# /data/.gitignore
*
!.gitkeep
!.gitignore
```

Pre-commit hook blocks real data AND broken code:
```bash
# .husky/pre-commit
if git diff --cached --name-only | grep -q "^data/raw/"; then
  echo "ERROR: Real data files must not be committed"
  exit 1
fi
npm run check
```

## Dependency supply chain

Two npm-native guards live in `.npmrc` (no extra tooling — npm >= 11):

- **`strict-allow-scripts=true`** — dependency install scripts are default-DENY. Only the packages pinned in the `allowScripts` field of the root `package.json` may run `preinstall`/`install`/`postinstall`. Anything else hard-fails the install with `ESTRICTALLOWSCRIPTS`. Without this flag `allowScripts` is advisory: npm prints a warning and runs the script anyway.
- **`min-release-age=7`** — only install versions public for 7+ days, so a compromised release is usually yanked before we'd ever resolve it. Affects resolution (`npm install`) only; **`npm ci` installs the lockfile verbatim and is unaffected**, so CI and releases never fail on it.

`.github/dependabot.yml` carries a matching 7-day `cooldown`. That gates Dependabot's PRs; `min-release-age` gates every install. Neither delays **security** updates — Dependabot security PRs ignore cooldown by design, so `audit-ci` always gets its patch immediately.

**When `npm ci` fails with `ESTRICTALLOWSCRIPTS`:** a dependency introduced a new install script. Do NOT reach for `--dangerously-allow-all-scripts`. Read the script, and if it's legitimate:
```bash
npm approve-scripts <pkg>   # then commit the package.json change
```
Two caveats, both hit in practice:
- `npm approve-scripts` is **workspace-unaware** and can miss a nested duplicate (we ship two `esbuild` copies). Always re-run `npm ci` afterwards and trust its error over the command's output.
- A package can only be **version-pinned** (`pkg@1.2.3`) if its lockfile entry has a `resolved` URL — npm derives trusted identity from that URL, never from the tarball's own `package.json`. ~298 of our lockfile entries currently lack `resolved`/`integrity`, so `esbuild` is allowlisted **by bare name** (any version) rather than pinned. Regenerating the lockfile so every entry carries `resolved` + `integrity` would let us tighten that to an exact pin.

## Versioning & releases

The project version lives in `package.json` and `packages/desktop/package.json` — **keep the two in sync** (CI rejects a mismatch). Releases are cut by pushing a `v<version>` tag, which triggers `release.yml` (it verifies the tag matches `package.json`, then builds and publishes).

**Rule: `package.json` must be exactly one release ahead of the latest `v*` tag** — the next patch (`X.Y.Z+1`), or a deliberate minor (`X.Y+1.0`) / major (`X+1.0.0`). The `version bumped past latest release` CI job enforces this on every PR.

What this means in practice:
- **Don't bump on every PR.** Once `main` is one release ahead of the latest tag, that version is correct — further PRs inherit it and change nothing. Only the **first** PR of a new release cycle bumps the version.
- **Don't over-increment.** If the latest tag is `v0.2.6`, the target is `0.2.7`. Setting `0.2.8` (skipping `0.2.7`) is rejected — pick `0.2.7`, or, for an intentional minor/major release, `0.3.0` / `1.0.0`.
- A bump (when needed) updates **only the two `package.json` files** (root + `packages/desktop`) together — **leave `package-lock.json` alone.** Its version field intentionally drifts (it currently lags several releases behind) and the `version-bump` CI job reads *only* the two `package.json` files. A version-only bump needs no `npm install`.

So the lifecycle is: tag `v0.2.6` released → first PR bumps both to `0.2.7` → subsequent PRs stay at `0.2.7` → maintainer tags `v0.2.7` to release → next PR bumps to `0.2.8`.

**A deliberate minor/major (`0.5.0`, `1.0.0`)** is just a first-PR bump that jumps the minor/major instead of the patch — allowed even when `main` already sits one patch ahead, because the CI check accepts any of `next_patch` / `next_minor` / `next_major` relative to the latest tag. E.g. latest tag `v0.4.1`, `main` at `0.4.2` → a release PR may set `0.5.0` (replacing the unreleased `0.4.2`).

> ⚠️ The pre-commit hook runs `npm run check`, which needs the worker bundle built first — run `npm run build:worker --workspace=packages/desktop` once before committing, or the commit fails on 2 worker tests (unrelated to the version change).

## After pushing — close the review loop

A development cycle isn't done when the code is pushed. Once the changes are pushed and the PR is open, run BOTH of the following before considering the work finished.

### 1. `/code-review ultra --fix`

At the end of a dev cycle (changes just pushed), run `/code-review ultra --fix` — a deep, multi-agent review that runs in the cloud and applies its findings to the working tree.

- **It is user-triggered and billed — you (Claude) cannot launch it** (not via Bash, the `Skill` tool, or otherwise). When a cycle wraps, prompt the user to run it; don't attempt to invoke it yourself.
- `ultra` reviews the current branch; `/code-review ultra <PR#>` reviews a specific GitHub PR. `--fix` applies the review's findings to the working tree after it completes (use `--comment` instead to post them as inline PR comments).
- After it applies fixes: review the resulting diff, run `npm run check` (build the worker first — see the versioning note above), then commit and push. Treat anything it changed as a normal change that must pass verification.
- The lighter effort levels (`/code-review` at low…max, optionally `--fix` / `--comment`) you *can* run yourself via the `Skill` tool for a quick local pass mid-development — only `ultra` is off-limits to you.

### 2. Sentry comments

This repo has Sentry's AI reviewer (`sentry[bot]`) configured. **Every PR you open, always check for and address its review comments** before considering the PR done — don't leave them unanswered.

For each `sentry[bot]` comment:
1. **Verify it against the actual code** — trace the data/control flow end-to-end; Sentry raises real bugs *and* false positives, so don't fix on faith or dismiss on reflex.
2. **If valid** — fix it, run `npm run check`, and reply to the comment noting the fix (reference the commit SHA).
3. **If a false positive** — reply explaining precisely why, citing the code paths that disprove it.
4. **Answer Sentry's "Did we get this right? 👍 / 👎 to inform future reviews." footer** by reacting on the comment: 👍 (`+1`) when the finding was valid, 👎 (`-1`) when it was a false positive. This feeds Sentry's model.

Fetch comments and reply/react with `gh`:
```bash
gh api repos/etiennechabert/cost-goblin/pulls/<pr>/comments --jq '.[] | select(.user.login=="sentry[bot]") | {id, path, line, body}'
gh api -X POST repos/etiennechabert/cost-goblin/pulls/<pr>/comments/<id>/replies -f body="…"
gh api -X POST repos/etiennechabert/cost-goblin/pulls/comments/<id>/reactions -f content='+1'   # or -1
```
Keep replies professional and free of any AI attribution (see global git rules).

## Key Architecture Decisions

- **Tag normalization at query time** — aliases applied via SQL, not during sync. Changing aliases takes effect immediately.
- **FOCUS 1.2 is the core schema** — the AWS source is the FOCUS 1.2 Data Export (Parquet); providers are receivers that deliver FOCUS Parquet into per-month `raw/{tier}-{YYYY-MM}/` dirs. Queries read the downloaded Parquet as-is (no repartitioning); per-month dirs give file-level date filter pushdown.
- **No SQLite** — all state is YAML (user config) or JSON (app state). DuckDB is the only database.
- **CostApi interface is the boundary** — UI codes against the interface, never calls DuckDB directly. Enables mock testing and future web mode.
- **Dark mode default, light mode available** — two chart color palettes (standard + Okabe-Ito colorblind-safe), togglable.

## SQL Security — Parameterized Queries Required

**ALL database queries MUST use parameterized queries** — never string interpolation. Config files can be shared via git and could contain malicious values.

- **User-controlled values** (dates, filter values, thresholds, entity values) → use `QueryBuilder.addParam()` to produce `$1`, `$2`, ... placeholders
- **Identifiers** (dimension IDs, column names) → validated by `resolveField` / `validateColumnName` against the dimensions config allow-list; unknown identifiers throw `SecurityError`
- **Config string literals** interpolated into SQL (e.g. `missingValueTemplate`, `accountTagFallback`) → escaped with `sqlEscapeString`

## Frontend Stack

- React 19 + shadcn/ui + Radix primitives (component library, copy-paste, fully owned)
- Tailwind CSS v4 (styling)
- visx from Airbnb (charts — D3 primitives as React components)
- TanStack Table (headless table with virtual scrolling)
- Framer Motion (subtle animations)
- Lucide React (icons)

## What NOT To Do

- Do NOT skip `npm run check`. Every change must pass before moving on.
- Do NOT consider a pushed change "done" until `/code-review ultra --fix` has been run on it and every `sentry[bot]` comment is addressed.
- Do NOT add `any`, `@ts-ignore`, or `eslint-disable` to make code compile.
- Do NOT write tests after implementation. Write them before or alongside.
- Do NOT import from `core` into `ui` for anything except types.
- Do NOT commit anything from `data/raw/`.
- Do NOT use `localStorage` or `sessionStorage` — this is Electron, use the state JSON files.
- Do NOT use Recharts — use visx for full visual control.
- Do NOT create a separate CSS file per component — use Tailwind utilities.
