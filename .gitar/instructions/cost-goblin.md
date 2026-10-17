# CostGoblin: notes for every Gitar run

Review guidance lives in `.gitar/review/`; this file is what every run needs, including CI analysis and fixes.

## Reading CLAUDE.md

You also load `CLAUDE.md`. It is written for the maintainer's local Claude Code sessions, so it mixes two kinds of content:

- **Repository rules.** Enforce these in reviews and follow them in anything you commit: "TypeScript Rules", "Linting Rules", "Testing Approach", "Fixture Data", "Git Safety", "Dependency supply chain", "Versioning & releases", "Key Architecture Decisions", "SQL Security", "Frontend Stack" and "What NOT To Do".
- **The maintainer's local workflow.** Not addressed to you, and nothing to ask of a PR author: the "Development Workflow" steps, "After pushing — close the review loop" (`/code-review`, answering `sentry[bot]`, `gitar-bot[bot]` and SonarCloud), and the notes on `make`, worktrees and the pre-commit hook.

## Where things live

CLAUDE.md's "Monorepo Structure" has the top level. Inside it:

- `packages/core/src/`: `config/` (YAML loading, validation, serialization), `query/` and `normalize/` (SQL building), `rollup/`, `baseline/`, `sync/` (S3 and GCS), `peer/` (the sharing protocol), `telemetry/`, and the e2e tooling in `e2e-coverage/` and `e2e-harness/`.
- `packages/desktop/src/main/`: the IPC handlers (`handlers/`), the DuckDB worker pool, sync orchestration, the aws and gcloud CLI integration, the MCP host, the sharing listener and the updater.
- `packages/ui` reaches the app only through `CostApi` (`packages/ui/src/api/CostApi.ts`).
- `packages/mcp` serves tools to AI assistants, including `run_sql` over the user's billing data.

`workers/signup` and `scripts/gcp-focus-exporter` have their own lockfiles and sit outside the root `.npmrc` guards.

## CI

| Check | What it runs |
| - | - |
| `lint` | `tsc --noEmit` for core, ui, desktop and mcp, then `eslint packages/*/src/` |
| `test-unit` | `npm run build:worker --workspace=packages/desktop`, then `vitest run --coverage`, which includes `scripts/**/*.test.mjs` |
| `test-e2e (<shard>)` | builds the desktop app, then runs `e2e/<shard>.test.ts` under `xvfb-run` with `COSTGOBLIN_HEADLESS=0` |
| `security-audit` | `.github/scripts/assert-npm-guards.sh`, the lockfile `resolved`/`integrity` check, `npm ci`, `audit-ci` |
| `version bumped past latest release` | both `package.json` files must agree and sit exactly one release past the latest `v*` tag |
| `sonarcloud` | merges unit and e2e coverage, then applies the quality gate |

When one of them fails:

- **`npm ci` fails with `ESTRICTALLOWSCRIPTS`.** A dependency, usually `esbuild` (transitive under `vite` and `tsx`), moved to a version whose install script has no pin in the root `package.json` `allowScripts`. Name the package and both versions, and point to CLAUDE.md's approval flow. Don't add or edit `allowScripts` entries yourself: approving an install script is the maintainer's security decision.
- **The version check fails.** Set the root and `packages/desktop/package.json` versions to the one the job log expects. Leave `package-lock.json` alone.
- **A policy test fails**, such as `scripts/ci/workflow-policy.test.mjs`, `scripts/ci/assert-npm-guards.test.mjs`, `scripts/ci/check-cla.test.mjs`, `scripts/ci/gitar-config.test.mjs`, `packages/core/src/__tests__/e2e-cloud-sandbox.test.ts` or `packages/core/src/__tests__/focus-1-2-samples.integration.test.ts`. These pin an invariant; change the code to meet it, never the test.
- **`e2e/collect-coverage.ts` reports coverage inflation.** A suite awaited something between `firstWindow()` and `attachCoverage` (CLAUDE.md, "Coverage-attach ordering"). It is a bug, not flakiness.
- **The Sonar gate fails on coverage.** The fix is tests. Exclusions in `sonar-project.properties` are not.

## Anything you commit

This covers CI fixes, `gitar fix`, applied suggestions and rule actions.

- Keep CLAUDE.md's TypeScript and lint rules even to get CI green: no `any`, `as`, `!`, `@ts-ignore`, `@ts-expect-error`, `eslint-disable` or `console.log`.
- Never change a test's expected values, or skip, delete or loosen a test, to make it pass. If the PR means to change that behavior, say so instead.
- Never hand-edit a lockfile, and never commit anything under `data/` or any billing export.
- Leave `.github/`, `.npmrc`, `package.json` `allowScripts` and `overrides`, `electron-builder.yml`, `scripts/build/`, `.gitar/`, `.claude/` and `CLAUDE.md` unchanged unless the maintainer asks for that change in a comment.
- Write commit subjects the way the history does: `type(scope): summary`, such as `fix(ui): …` or `test(e2e): …`.
