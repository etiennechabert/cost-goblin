# Incremental migration to a Rust core via Tauri

> Tracking issue: [#360](https://github.com/etiennechabert/cost-goblin/issues/360)
> Status: **spike landed** (this PR) — proceeding incrementally, reversibly.

## Decision

Proceed with an **incremental, reversible** migration that keeps the entire
React/shadcn/visx UI verbatim and moves the backend (the Electron main process +
the TypeScript `core`) to a **Rust backend driven through [Tauri](https://tauri.app/)**.

This is deliberately scoped *against* a ground-up rewrite. Roughly half the
codebase is UI — the part Rust serves worst (no mature equivalents for shadcn,
Radix, visx, TanStack Table, Framer Motion). The logic is the smaller half and
the part Rust serves best. We migrate only where Rust pays off, behind the
`CostApi` boundary, one layer at a time, with Electron left fully working until
parity is proven.

The `web-backend` reuse question (a Rust core is not reusable by a future
TypeScript web backend the way `@costgoblin/core` is today) is **deprioritised**
for this decision — it is noted as a cost but does not block.

## What the spike proves (this PR)

The spike lives in [`packages/tauri-shell/`](../packages/tauri-shell) and boots
the **real renderer** in a system WebView with a **Rust backend** that serves
the analytical views from the synthetic fixture Parquet via the native `duckdb`
crate. Run it with:

```bash
cd packages/tauri-shell && npm run tauri:dev
```

It validates the three things that actually carried risk:

1. **The IPC seam swap is small and mechanical.** The UI already codes against
   the `CostApi` interface and reads it from `window.costgoblin` (installed by
   Electron's `preload.ts`). The spike replaces *only that seam*: a
   [`bridge.ts`](../packages/tauri-shell/src/bridge.ts) installs the same
   `window.costgoblin` / `costgoblinUpdate` / `costgoblinDebug` globals, backed
   by Tauri `invoke` instead of Electron's `contextBridge`. The renderer is
   imported **verbatim** — no fork of `App.tsx`, `ui`, or any component.

2. **The native `duckdb` crate is a clean fit and arguably better than Node.**
   `@costgoblin/core`'s SQL builders (`buildSource`, `buildCostQuery`,
   `buildDailyCostsQuery`, trends, missing-tags, entity detail, the explorer
   queries) were ported to Rust string builders that produce the same SQL shape
   and run against the same Parquet. Result sets come back without the Node FFI /
   JSON-marshaling layer of `@duckdb/node-api`.

3. **Webview rendering parity.** The visx charts, TanStack tables, Radix
   popovers and Framer Motion animations render in macOS WebKit (the system
   WebView Tauri uses) from the same bundle Vite already produces for Electron.

### Scope of the spike (honest boundaries)

The spike was driven against a **real CUR dataset** (18 months, 138 org
accounts), which pushed it well past the original read-only core. Current state:

- **Real, served by Rust:** all analytical views (Overview, Trends, Missing
  Tags, Explorer, Entity detail) with **full-fidelity numbers matching Electron**
  — cost-metric from `cost-scope.yaml` (unblended/list/amortized), **cost-scope
  exclusion rules**, and the **org-account join** (resource→account tag
  fallback, account display names via `accountNameFromTag`, account-only dims
  like Unit via OU-path). Plus **Findings/Savings** (local cost-optimization
  Parquet), all config reads, data inventory, AWS profile list, tag/column
  discovery, filter values, and a live Debug query log.
- **Real AWS SDK (validated):** the **AWS Organizations sync** uses
  `aws-sdk-organizations` + `aws-config` (SSO/profile) for a real read-only
  traversal — confirming the issue's "AWS SDK for Rust is mature" claim end to
  end (credential resolution + live calls work).
- **Still stubbed (Phase 3/4):** S3 CUR download sync, SSM region names, config
  sharing, the auto-updater, the MCP server, and `save*` writes — client-side
  canned responses in `bridge.ts`.
- **Threading:** all commands are `#[tauri::command(async)]` so DuckDB/AWS work
  runs off the main thread (sync commands run on Tauri's main thread and freeze
  the UI). The spike has no result cache / materialized base yet, so repeat
  queries are slower than Electron but never block — Phase-2 work.
- **SQL safety:** dates strictly validated + interpolated; filter values bound as
  parameters.
- **Production rendering:** the official `tauri build` bundle renders; Vite's
  `crossorigin` attribute is stripped so embedded assets load under
  `tauri://localhost`.
- **Fixture freshness:** committed fixtures are Jan–Feb 2026; the renderer
  defaults to "last 30 days", so
  [`prepare-fixtures.ts`](../packages/tauri-shell/scripts/prepare-fixtures.ts)
  date-shifts a *copy* into `.fixtures/`. Committed fixtures are never modified.

### Footprint (measured, vs Electron v0.3.1 on macOS arm64)

| | Electron v0.3.1 | Tauri spike (release) |
|---|--:|--:|
| Installed `.app` | 409 MB | ~70 MB (**~6× smaller**) |
| Download (zipped) | 158 MB | ~22–30 MB |
| Runtime RSS (real data loaded) | ~3.3 GB | ~2.6 GB |

Bundle size is the clean structural win (no bundled Chromium/Node). Runtime RSS
is dominated by DuckDB's working set in **both**, so the memory delta is modest —
the "much lower idle memory" claim is overstated for real workloads; the
defensible wins are distribution size and startup.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  System WebView (WebKit / WebView2)                          │
│  packages/ui + packages/desktop/src/renderer  (VERBATIM)    │
│         │  window.costgoblin (CostApi)                        │
│         ▼                                                     │
│  packages/tauri-shell/src/bridge.ts   ← the only seam swap   │
│         │  Tauri invoke(cmd, { params })                      │
└─────────┼───────────────────────────────────────────────────┘
          ▼
┌─────────────────────────────────────────────────────────────┐
│  Rust backend (packages/tauri-shell/src-tauri)              │
│   commands.rs  — #[tauri::command] per CostApi read method   │
│   query.rs     — SQL builders ported from core/query         │
│   config.rs    — YAML config → CostApi JSON shapes           │
│   db.rs        — duckdb crate (bundled libduckdb)            │
└─────────────────────────────────────────────────────────────┘
```

The boundary is the existing `CostApi` interface
([`packages/core/src/types/api.ts`](../packages/core/src/types/api.ts)). It was
built to be swappable; the spike confirms it is.

## Phased migration plan

Each phase keeps Electron shipping and is independently revertible. A phase is
"done" when its surface reaches parity behind `CostApi` (functional + the
existing Playwright E2E + a visual check).

### Phase 0 — Spike *(this PR)* ✅
Tauri shell loading the real renderer; `CostApi` read-path via the `duckdb`
crate. In this PR the spike grew past the original boundary — see "Scope" above:
full-fidelity numbers, the org-account join, savings, a real AWS Organizations
sync, the Debug query log, and the off-main-thread command fix, validated on a
real CUR dataset.

### Phase 1 — Port the pure-logic `core` modules to Rust *(partially done in the spike)*
Config loader/validator, tag normalization + alias resolution, org-tree
traversal, cost math, sharing-bundle fingerprinting. These are pure functions
with rich Vitest suites — port them to Rust with **parity tests** that assert
the Rust output matches the TS output for the existing fixtures. Branded types
(`Brand<T,B>`) become real newtypes (`struct Dollars(f64)`); discriminated
unions become enums with exhaustive `match`; `{status:'error'}` states become
`Result<T, E>`.

### Phase 2 — Query builder + DuckDB execution *(largely done in the spike)*
The spike already ports cost-scope exclusions, the cost-metric expressions, the
org-account join, and account name/reverse-map merging. **Remaining:** the
in-memory materialized base table, the result cache + in-flight dedup from
`handlers/context.ts` (the spike re-reads Parquet per query — correct but
slower), org-tree rollup, and SQL-shape parity tests against the TS builder.

### Phase 3 — S3 sync + AWS Organizations + SSM *(Organizations done in the spike)*
Organizations sync is ported (`aws_org.rs`, validated read-only). **Remaining:**
port the S3 sync pipeline (`core/sync`) and SSM region names to `aws-sdk-s3` /
`aws-sdk-ssm`. This is the largest
behavioural surface (selective sync, data inventory, etag manifests, SSO
login). Validate against a real bucket in a controlled account.

### Phase 4 — Desktop main responsibilities → Tauri
Auto-sync scheduler, state JSON files (UI/savings/explorer prefs), the write
half of `CostApi` (`save*`), config sharing (export/import/S3 beacon), the MCP
server, and the auto-updater (Tauri's updater plugin replaces
`electron-updater`).

### Phase 5 — Re-home the toolchain
electron-builder → Tauri bundler; code signing + notarization for the Tauri
app; re-point the Playwright E2E harness and `--fixture-mode` wiring at the
Tauri build; update `ci.yml` / `release.yml` (the Tauri action builds per-arch
the same way the current matrix does). Keep the `version bumped past latest
release` guard.

### Phase 6 — Cutover & cleanup
Once parity is proven (functional + E2E + visual against the Electron
baseline), retire the Electron shell and the TypeScript `core`; `tauri-shell`
becomes the product.

## Risks & mitigations

| Risk | Assessment | Mitigation |
|---|---|---|
| **Marginal correctness gain** | The strict-TS setup already engineers out most bug classes Rust would catch. | Real upside is footprint/startup, not safety. Don't oversell it. |
| **No query-perf jackpot** | DuckDB's C++ does the heavy lifting in both worlds. | We shave FFI/JSON marshaling, not asymptotics. Measure, don't assume. |
| **Webview rendering parity** | Spike renders correctly in macOS WebKit; Windows WebView2 unverified. | Phase 5 verifies WebView2 against the Electron baseline before cutover. |
| **Velocity & hiring** | Rust contributors are scarcer than TS for a desktop app. | Incremental approach keeps TS shipping; only logic moves to Rust. |
| **`web-backend` reuse loss** | A Rust core won't be reusable by a TS web backend. | Deprioritised per #360; revisit if web-backend is greenlit. |
| **Build time** | Bundled libduckdb compiles from C++ source (~4 min cold). | One-time per machine/CI cache; incremental Rust builds are fast. |

## Open decisions (not blocking the spike)

- Single Rust crate vs. a `core-rs` library crate reused by `tauri-shell` and a
  future headless CLI.
- Whether to keep the spike's "dates interpolated, values parameterized" model
  or move fully to bound parameters in the production port (Phase 2).
- Updater hosting: reuse the current S3/release flow with Tauri's updater
  signing, or GitHub Releases.
