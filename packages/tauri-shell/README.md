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
| `aws_org.rs` | Real read-only AWS Organizations sync via `aws-sdk-organizations` (accounts + OU paths + tags), credentials/SSO via `aws-config`. |
| `querylog.rs` | In-memory query log powering the Debug panel. |
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

**Still stubbed (migration Phase 3/4 — "desktop-main → Tauri"):** S3 CUR
download sync, SSM region-name enrichment, config-sharing (export/import + S3
beacon), the auto-updater, and the MCP server. Plus `save*` writes (config edits
are in-memory). These are client-side canned responses in `bridge.ts`.

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
