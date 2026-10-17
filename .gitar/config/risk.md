CostGoblin's users make spending decisions from its numbers and trust it to keep billing data on their machine. Judge risk by what a change can get wrong there, whatever the diff size.

High risk:

- SQL building or execution: `packages/core/src/query/`, `packages/core/src/normalize/`, `packages/core/src/rollup/`, `packages/core/src/baseline/`, the `packages/mcp/src/tools/`, and any identifier, path or `read_parquet` glob that reaches SQL.
- Cost math users read as fact: which cost column is summed, filters, grouping, missing-tag handling, date windows and billing periods, rollup versus raw results.
- The Electron trust boundary: `packages/desktop/src/main/main.ts`, `packages/desktop/src/main/ipc.ts`, `packages/desktop/src/main/handlers/`, `packages/desktop/src/preload/`, spawning the aws or gcloud CLIs, and file paths built from config or peer input.
- Anything that sends data off the machine or accepts it from the network: telemetry (`packages/core/src/telemetry/`), the updater, peer sharing (`packages/core/src/peer/`), the MCP server (`packages/mcp/`), and the cloud credentials sync uses.
- Release, signing and supply chain: `.github/`, `scripts/build/`, `electron-builder.yml`, `.npmrc`, the `allowScripts`, `overrides` and `engines` fields of `package.json`, and any lockfile.
- What costgoblin.com collects or loads: `workers/signup/` and `docs/*.html`.

At least Medium risk:

- Config and state schemas, serializers, validators and migrations (`packages/core/src/config/`): files users already have must keep loading.
- Sync, download and prune logic, and anything else that writes into the data directory (`packages/core/src/sync/`).
- Test infrastructure whose failure would hide regressions: `e2e/helpers.ts`, `packages/core/src/e2e-harness/`, `packages/core/src/e2e-coverage/` and the policy tests in `scripts/ci/`.
- Gitar's own configuration in `.gitar/`, `CLAUDE.md` and `.claude/`.
