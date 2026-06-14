# @costgoblin/tauri-shell

Spike for [issue #360](https://github.com/etiennechabert/cost-goblin/issues/360):
run CostGoblin's **existing React renderer verbatim** on a **Rust + Tauri**
backend, with the analytical views served from the synthetic fixture Parquet via
the native `duckdb` crate.

This package is **additive** — it does not touch the Electron app, which keeps
working exactly as before. See [`specs/rust-tauri-migration.md`](../../specs/rust-tauri-migration.md)
for the decision and the phased migration plan.

## Run it

Prerequisites: a Rust toolchain (`rustup`) and the platform Tauri prerequisites
(on macOS: Xcode Command Line Tools).

```bash
# from the repo root
npm install

# from this package
cd packages/tauri-shell
npm run tauri:dev
```

`tauri:dev` first runs `prepare:fixtures` (see below), then launches the Tauri
window. **The first launch compiles a bundled DuckDB from C++ source (~4 min);
subsequent launches are fast.**

To produce a bundled app:

```bash
npm run tauri:build
```

## How it works

The UI already codes against the `CostApi` interface and reads it from the
`window.costgoblin` global that Electron's `preload.ts` installs. The only thing
this spike swaps is **that seam**:

- [`src/main.tsx`](src/main.tsx) installs the bridge, then dynamically imports
  and renders the **real** `App` from `packages/desktop/src/renderer` — no fork.
- [`src/bridge.ts`](src/bridge.ts) builds the same `window.costgoblin` /
  `costgoblinUpdate` / `costgoblinDebug` objects, routing read methods to Tauri
  `invoke(...)` and stubbing the cloud/AWS surface client-side.
- [`vite.config.ts`](vite.config.ts) serves the renderer and the shared `ui`
  package straight from source, reusing the desktop renderer's public assets.

The Rust backend (`src-tauri/src`):

| file | role |
|---|---|
| `main.rs` | Tauri builder; registers one `#[tauri::command]` per `CostApi` read method; resolves the fixture data/config dirs from env. |
| `commands.rs` | Command handlers — build SQL, run it, shape results to the exact `CostApi` JSON. |
| `query.rs` | SQL builders ported from `@costgoblin/core` (`buildSource`, cost/daily/trend/entity/missing-tags + explorer queries), dimension resolution, normalize/alias `CASE` SQL. |
| `config.rs` | Loads the YAML config fixtures and reshapes them into the `CostApi` JSON shapes. |
| `db.rs` | Thin `duckdb` crate helpers (per-query in-memory connection, parameter binding, row → JSON). |

## What's real vs. stubbed

**Real (Rust + DuckDB over the fixtures):** Cost Overview, Trends, Missing Tags,
Explorer (overview / sample rows / aggregated table / facet filters), Entity
detail, all config reads, data inventory, tag/column discovery, filter values.

**Stubbed (valid shapes, inert):** S3 sync, AWS Organizations/SSM, config
sharing, the MCP server, the auto-updater, Savings (no cost-optimization
fixture), and all `save*` writes (config edits are in-memory). These are
client-side canned responses in `bridge.ts`.

## Deliberate fidelity deviations

- **Account labels:** grouped by `account_name` (the dimension's `displayField`)
  so labels and filters are self-consistent without an org-accounts map. Electron
  in fixture mode shows raw account IDs because no `org-accounts.json` exists.
- **Cost scope / org-tree rollup** are not applied — the fixture has all
  exclusion rules disabled and the landing views don't roll up by owner.
- **SQL safety:** date strings are strictly validated (`YYYY-MM-DD`) then
  interpolated; arbitrary filter values are bound as parameters. The production
  port (migration Phase 2) would move fully to bound parameters.

## Fixtures

The committed synthetic fixtures (`packages/core/src/__fixtures__/synthetic`)
are dated Jan–Feb 2026, but the renderer's default window is "last 30 days".
[`scripts/prepare-fixtures.ts`](scripts/prepare-fixtures.ts) date-shifts a *copy*
into `./.fixtures/` (gitignored) so the latest row lands on ~today and the
landing dashboard is populated. The committed fixtures are never modified.

Point at a different dataset/config with the same env vars Electron uses:
`COSTGOBLIN_DATA_DIR` and `COSTGOBLIN_CONFIG_DIR`.
