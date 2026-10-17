Only fix a finding automatically when the fix is local and mechanical: it stays within the lines the PR changed in one file, and it changes no exported type, IPC or `CostApi` contract, config schema, or test expectation.

Never apply a fix automatically, at any severity, in:

- SQL building or execution, cost math, tag normalization, rollups or baselines (`packages/core/src/query/`, `packages/core/src/normalize/`, `packages/core/src/rollup/`, `packages/core/src/baseline/`, `packages/mcp/`).
- The Electron trust boundary and anything that sends or receives data over the network: `packages/desktop/src/main/`, `packages/desktop/src/preload/`, `packages/core/src/peer/`, `packages/core/src/telemetry/`, `packages/core/src/sync/`, `workers/signup/`.
- Release, CI and supply chain: `.github/`, `scripts/`, `electron-builder.yml`, `.npmrc`, any `package.json` or lockfile.
- Gitar's and Claude Code's own configuration: `.gitar/`, `.claude/`, `CLAUDE.md`.

Leave those findings open for the author.
