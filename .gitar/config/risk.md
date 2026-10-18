CostGoblin's users make spending decisions from its numbers and trust it to keep billing data on their machine. Judge risk by what a change can get wrong there, whatever the diff size.

The paths below name production code: a PR that only changes tests under them isn't raised by this file, though the security tests listed below and the test infrastructure under "At least Medium" still are. When a label comes from this file, name the entry it matched.

High risk:

- SQL building or execution: `packages/core/src/query/`, `packages/core/src/normalize/`, `packages/core/src/rollup/`, `packages/core/src/baseline/`, `packages/desktop/src/main/rollup-store.ts` (which periods queries may read from the rollup), the `packages/mcp/src/tools/`, and any identifier, path or `read_parquet` glob that reaches SQL.
- Cost math users read as fact: which cost column is summed, filters, grouping, missing-tag handling, date windows and billing periods, rollup versus raw results.
- The Electron trust boundary: `packages/desktop/src/main/main.ts`, `packages/desktop/src/main/window-guards.ts`, `packages/desktop/src/main/window-security.ts`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/main/handlers/`, `packages/desktop/src/preload/`, spawning CLIs (`packages/core/src/sync/trusted-binaries.ts`), and file paths built from config or peer input.
- Anything that sends data off the machine or accepts it from the network: telemetry (`packages/core/src/telemetry/`, `packages/desktop/src/main/telemetry/`), the updater (`packages/desktop/src/main/update-manager.ts`), peer sharing (`packages/core/src/peer/`), the MCP server (`packages/mcp/`, `packages/desktop/src/main/mcp-sandbox.ts`), and the cloud credentials sync uses.
- Release, signing and supply chain: `.github/`, `scripts/build/`, `electron-builder.yml`, `.npmrc`, the `allowScripts`, `overrides` and `engines` fields of `package.json`, and any lockfile.
- What costgoblin.com collects or loads: `workers/signup/`, any change to `docs/privacy.html`, and a `docs/*.html` change that loads a new third-party resource, sends data to a new destination, sets a cookie or stores anything in the browser, or collects a new field.
- A PR that deletes or weakens assertions in a security test: `packages/mcp/src/__tests__/run-sql-validate.test.ts`, `packages/mcp/src/__tests__/output-neutralization.test.ts`, `packages/mcp/src/__tests__/format-neutralize.test.ts`, `packages/core/src/__tests__/sql-escaping.integration.test.ts`, `packages/core/src/__tests__/docs-security-claims.test.ts`, `packages/core/src/__tests__/e2e-cloud-sandbox.test.ts`, `e2e/csp-verification.test.ts`, `e2e/sandbox-verification.test.ts`.

At least Medium risk:

- Config and state schemas, serializers, validators and migrations (`packages/core/src/config/`): files users already have must keep loading.
- Sync, download and prune logic, and anything else that writes into the data directory (`packages/core/src/sync/`).
- Test infrastructure whose failure would hide regressions: `e2e/helpers.ts`, `e2e/global-setup.ts`, `e2e/collect-coverage.ts`, `packages/core/src/e2e-harness/`, `packages/core/src/e2e-coverage/` and the policy tests in `scripts/ci/`.
- Gitar's own configuration in `.gitar/`, `CLAUDE.md` and `.claude/`.
