# @costgoblin/tauri-shell

Spike for [issue #360](https://github.com/etiennechabert/cost-goblin/issues/360):
run CostGoblin's **existing React renderer verbatim** on a **Rust + Tauri**
backend, with the analytical layer served by the native `duckdb` crate and the
AWS Organizations sync by the native `aws-sdk` crates.

This package is **additive** — it does not touch the Electron app, which keeps
working exactly as before. See [`specs/rust-tauri-migration.md`](../../specs/rust-tauri-migration.md)
for the decision and the phased migration plan.

It has been driven against a **real CUR dataset** (18 months, 138 org accounts),
not just the synthetic fixtures.

## Run it

Prerequisites: a Rust toolchain (`rustup`), the platform Tauri prerequisites
(macOS: Xcode Command Line Tools), and `cmake` (for the bundled DuckDB +
`aws-lc`). Build the release bundle (renders from embedded assets, self-contained):

```bash
npm install                         # repo root
cd packages/tauri-shell
npm run tauri:build                 # → src-tauri/target/release/bundle/macos/*.app
```

First build compiles bundled DuckDB + the AWS SDK from source (~several min);
incremental builds are seconds. For hot-reload dev: `npm run tauri:dev` (runs
`prepare:fixtures`, then Vite + the Rust backend on the synthetic fixtures).

Point at any dataset/config with the same env vars Electron uses —
`COSTGOBLIN_DATA_DIR` and `COSTGOBLIN_CONFIG_DIR` (e.g. the Electron userData
path to run on real synced data).

## How it works

The UI already codes against the `CostApi` interface and reads it from the
`window.costgoblin` global that Electron's `preload.ts` installs. The only thing
this spike swaps is **that seam**:

- [`src/main.tsx`](src/main.tsx) installs the bridge, then dynamically imports
  and renders the **real** `App` from `packages/desktop/src/renderer` — no fork.
- [`src/bridge.ts`](src/bridge.ts) builds the same `window.costgoblin` /
  `costgoblinUpdate` / `costgoblinDebug` objects, routing methods to Tauri
  `invoke(...)`. (Synchronous debug methods like `getInFlightCount` stay JS-side.)
- [`vite.config.ts`](vite.config.ts) serves the renderer + shared `ui` package
  from source and strips Vite's `crossorigin` attribute so the bundled assets
  load under Tauri's `tauri://localhost` protocol in the release build.

The Rust backend (`src-tauri/src`):

| file | role |
|---|---|
| `main.rs` | Tauri builder; registers the commands; resolves data/config dirs from env. |
| `commands.rs` | One `#[tauri::command(async)]` per CostApi method — **async so DuckDB/AWS work runs off the main thread** (see Threading). Shapes results to the exact CostApi JSON. |
| `query.rs` | SQL builders ported from `@costgoblin/core` (`buildSource` incl. **org-account join**, cost/daily/trend/entity/missing-tags + explorer queries), cost-metric selection, **cost-scope exclusions**, normalize/alias `CASE`. |
| `config.rs` | Loads the YAML config + `org-accounts.json` (account-name + tag-fallback maps). |
| `config_write.rs` | YAML config **writes** — ports the core `*ConfigToYaml` transformers (dimensions / views / cost-scope) + the surgical `updateAwsProfile`. |
| `aws_org.rs` | Real read-only AWS Organizations sync via `aws-sdk-organizations` (accounts + OU paths + tags), credentials/SSO via `aws-config`. |
| `aws_ssm.rs` | Real read-only SSM region-name enrichment (`aws-sdk-ssm`) → `region-names.json`. |
| `sync.rs` | S3 CUR download sync — bulk download via the `aws s3 sync` CLI; remote inventory via `aws-sdk-s3` ListObjectsV2; progress + cancel. |
| `bundle.rs` | Config-bundle assembly + SHA-256 fingerprint + parse/summarize/materialize (config sharing). |
| `sharing.rs` | Config-sharing S3 get/put + pre-import backup. |
| `querylog.rs` | In-memory query log powering the Debug panel. |
| `mcp.rs` | Token-authed JSON-RPC MCP server (`tiny_http`, loopback) over the query layer. |
| `db.rs` | `duckdb` crate helpers (per-query in-memory connection, param binding, row → JSON), with query-log instrumentation. |

## What's real vs. stubbed

**Real:**
- All analytical views: Cost Overview, Trends, Missing Tags, Explorer
  (overview / sample rows / aggregated table / facet filters), Entity detail.
- **Full-fidelity numbers** matching Electron: cost-metric from `cost-scope.yaml`
  (unblended / list / amortized), **cost-scope exclusion rules**, and the
  **org-account join** (resource→account tag fallback, account display names from
  the configured `accountNameFromTag`, account-only dims like Unit via OU-path).
- **Findings / Savings** — read from the local cost-optimization Parquet.
- **AWS Organizations sync** — real read-only `aws-sdk-organizations` call
  (SSO/profile via `aws-config`); refreshes `org-accounts.json`.
- All config reads, data inventory, AWS profile list (`~/.aws`), tag/column
  discovery, filter values, Debug query log.
- **MCP server** (`mcp.rs`) — token-authed JSON-RPC HTTP server (loopback) over
  the query layer (`get_cost_overview`, `query_costs`, `list_dimensions`,
  `get_filter_values`), toggled from the AI Assistant view.
- **Preferences persist** (UI / explorer / savings JSON) and **Open/Reveal
  Folder** use the OS opener.
- **YAML config writes** (`config_write.rs`) — saving dimensions / views /
  cost-scope and the surgical "change AWS profile" write the real YAML files,
  reusing the core `*ConfigToYaml` shape so they round-trip cleanly.
- **AWS Organizations + SSM region sync** — real read-only `aws-sdk-organizations`
  and `aws-sdk-ssm` calls (org sync piggybacks the region-name sync, as Electron
  does); `clearOrgData` wipes the caches.
- **S3 CUR download sync** (`sync.rs`) — the faithful port: bulk download shells
  out to the **`aws s3 sync` CLI** (reuses SSO, multipart, incremental skips;
  files land directly in `aws/raw/{tier}-{period}/`). Remote inventory via
  `aws-sdk-s3` ListObjectsV2 drives the period picker; progress is polled via
  `getSyncStatus`; cancellation kills the child process. `aws sso login` from the
  app via `ssoLogin`.
- **Config sharing** (`bundle.rs` + `sharing.rs`) — bundle export/import via
  native file dialogs, SHA-256 fingerprint (round-trips as valid), and S3
  publish / fetch / beacon discovery.

**Caveats / one genuine blocker:**
- **Auto-updater** — the *interface* is ported (state machine + a working
  `onStatusChanged`, so the release-notes modal works), but a check honestly
  reports "idle": actually finding an update needs a **Tauri-format signed
  release feed**, and the project's GitHub releases are electron-builder format.
  Wiring `tauri-plugin-updater` is blocked on that feed + EdDSA signing, not on
  the Rust port.
- **Live AWS** (org/SSM/S3 sync, config publish/fetch) needs a valid SSO session
  (`aws sso login --profile <profile>`); the S3 sync also needs the AWS CLI
  installed. The remote inventory falls back to a local-only scan when offline.
- **Still stubbed:** setup-wizard-only AWS discovery (`listS3Buckets`,
  `browseS3`, `testConnection`, `scaffoldConfig`/`writeConfig`) — the spike runs
  against an already-configured dataset, so the wizard path is inert.

## Threading

Tauri runs **synchronous** commands on the main thread, so heavy DuckDB/AWS work
would freeze the window. All commands are therefore `#[tauri::command(async)]`,
which Tauri runs on worker threads — concurrent queries run in parallel and the
UI stays responsive. (The spike has **no result cache or materialized base
table** yet — both exist in Electron's `handlers/context.ts` — so repeat queries
are slower than Electron though never blocking; that's Phase-2 work.)

## Notes & deliberate deviations

- **SQL safety:** date strings are strictly validated (`YYYY-MM-DD`) then
  interpolated; arbitrary filter values are bound as parameters. A production
  port would move fully to bound parameters.
- **Fixtures freshness:** the committed synthetic fixtures are dated Jan–Feb 2026
  but the renderer's default window is "last 30 days".
  [`scripts/prepare-fixtures.ts`](scripts/prepare-fixtures.ts) date-shifts a
  *copy* into `./.fixtures/` (gitignored) so the dev fixtures land on ~today. The
  committed fixtures are never modified.

## Footprint (vs Electron v0.3.1, measured)

| | Electron v0.3.1 | Tauri spike (release) |
|---|--:|--:|
| Installed `.app` | 409 MB | ~70 MB (~6× smaller) |
| Download (zipped) | 158 MB | ~22–30 MB |
| Runtime RSS (real data, loaded) | ~3.3 GB | ~2.6 GB |

Bundle size is the clean structural win (no bundled Chromium/Node). Runtime RSS
is dominated by DuckDB's working set in **both**, so the memory delta is modest —
the issue's "much lower idle memory" is overstated for real workloads.
