# Feature Audit — 2026-05

A snapshot of every shipped feature in CostGoblin, grouped by how much value it currently earns vs. how much complexity it costs. This is not a roadmap or a deletion list — it is a question list for the next planning round.

> Scope: the desktop app as of `main` at the time of writing. Companion docs: [`refactoring-targets.md`](refactoring-targets.md), the source-of-truth product spec in [`/SPEC.md`](../SPEC.md).

---

## 1. Core value loop — keep, do not touch

These features are why someone opens the app. Reducing them would damage the product.

| Feature | Where | Why it earns its keep |
|---------|-------|----------------------|
| Cost Overview (seed view) | `ui/src/views/cost-overview.tsx`, seed in `core/types/seed-views.ts` | First screen after sync; the headline value prop. |
| Explorer | `ui/src/views/explorer.tsx` | Free-form pivot — the power-user surface. Heavy LOC but well-justified. |
| Cost Trends | `ui/src/views/cost-trends.tsx` | The "why did spend change" question. Sized correctly. |
| Entity Detail | `ui/src/views/entity-detail.tsx` | The drill-down terminus from every other view. |
| Dimensions Editor + tag normalization at query time | `ui/src/views/dimensions.tsx`, `core/src/normalize/`, `core/src/query/builder.ts` | The differentiator vs. AWS-native tooling. |
| Setup Wizard | `ui/src/views/setup-wizard.tsx` | Required for first-run; bounded scope. |
| Sync View + Data Inventory + auto-sync | `ui/src/views/data-management*.tsx`, `desktop/src/main/auto-sync.ts` | Non-negotiable: data is local, the user has to see and control it. |
| AWS Organizations integration | `desktop/src/main/aws-org-client.ts` | Accounts without names are unusable for non-trivial orgs. |
| Auto-update | `desktop/src/main/update-manager.ts` + `UpdateApi` | Required to actually ship a desktop binary. |

---

## 2. Earning their keep, but heavy

Real users today. The cost is the implementation footprint, not the feature itself.

### Cost Scope / exclusion rules
- `ui/src/views/cost-scope.tsx` (~1.09k LOC) + `desktop/src/main/handlers/cost-scope.ts` (~335 LOC)
- Useful (exclude AWS support, refunds, internal accounts; pick metric variant) but the UI is overbuilt for what's effectively a list of `WHERE` clauses with a metric switch.
- See [`refactoring-targets.md`](refactoring-targets.md) — splitting the preview / metric selector out of the view shrinks the heaviest cost without dropping the feature.

### Missing Tags view
- `ui/src/views/missing-tags.tsx` (~546 LOC)
- Cost-allocation hygiene is genuinely useful, but the **bucketing strategy selector** adds a knob most users won't touch. A single sensible default plus a hidden tweak in YAML would carry the same value.

---

## 3. Drop-or-shrink candidates

Features whose pull-weight is unproven and whose complexity is large enough to warrant a real conversation.

### MCP Server (`packages/mcp` + `desktop/src/main/mcp.ts` + `ui/src/views/mcp-view.tsx`)
- 18 files, ~1.2k LOC inside the MCP package, plus a separate HTTP server, 10 tools (including `run-sql.ts` — arbitrary DuckDB execution), an IPC toggle, and a dedicated view.
- **Open question:** is there evidence that real users wire Claude / ChatGPT / Gemini to a local desktop app? The fact that the MCP view ships **instructions** for three different vendors suggests we've never seen a single confirmed user.
- **If kept:** keep, but stop expanding it until there's signal. Add a feature-usage counter (local-only) on `setMcpServerRunning(true)`.
- **If dropped:** the surface deletes cleanly — `packages/mcp` is isolated, the toggle and view come out as a unit, and the desktop handler is one file. Roughly a one-day removal.

### Custom Views Editor + Views Editor
- `ui/src/views/custom-view.tsx`, `ui/src/views/views-editor.tsx` (~487 LOC), plus the `getViewsConfig` / `saveViewsConfig` / `resetViewsConfig` / `revealViewsFolder` IPC surface.
- The hardcoded `OVERVIEW_SEED_VIEW` covers the standard cases. A YAML editor for view layouts is a power-user feature that adds a config surface to maintain (and to document, and to migrate when widget specs change).
- **If kept:** acknowledge it as an MVP feature in the spec (already done in this PR), and accept the maintenance load.
- **If dropped:** the seed view still renders fine; the dimensions/views config simplification cascades through several handlers.

### Region enrichment via SSM
- `desktop/src/main/aws-ssm-client.ts` + `ui/src/views/data-management-ssm.tsx` + `getRegionNamesInfo` / `syncRegionNames` / `clearOrgData` API surface.
- Country / continent grouping is niche and pulls in `@aws-sdk/client-ssm` as a dependency.
- **If kept:** it's well-isolated and the failure mode is non-fatal. Worth keeping unless the AWS SDK weight is biting binary size.
- **If dropped:** the Region dimension still works with raw AWS codes (`eu-central-1`).

### `query-log.ts`
- `desktop/src/main/query-log.ts` tracks the origin of every query but exposes nothing to the UI.
- **Decision:** either wire it to a dev-only stats panel, or delete it. It's currently invisible work.

### Debug panel / CPU profiler
- `ui/src/renderer/debug-panel.tsx` + `COSTGOBLIN_PERF_MODE` env var in `main.ts`.
- Fine as a dev affordance, but in a shipped binary an env-var-toggleable profiler is a (small) surface area for surprise behavior. Gate it to `NODE_ENV !== 'production'` builds.

### `ConceptPlaceholder` component
- `ui/src/components/concept-placeholder.tsx` exists but isn't imported anywhere. Either re-introduce the "grayed out concept widget" UX in the seed view (which is what the spec used to describe), or delete the component. Currently it's dead.

---

## 4. Watchlist — don't drop, but instrument

Features that *might* be quietly under-used. Need data before deciding.

### Savings view + cost-optimization tier
- `ui/src/views/savings.tsx` (~420 LOC) + a whole separate sync tier with a different Parquet shape (`aws/raw/cost-optimization-*`) + `SavingsPreferences` persistence.
- AWS already surfaces these recommendations in the console for free. The value of doing it again locally is "you can browse them next to your spend without switching tabs." That's real but narrow.
- **Action:** if any usage-counter mechanism gets added (see MCP item), Savings is the second feature to instrument.

---

## 5. Pure consistency / cleanup notes

Small things that aren't features but accumulated:

- The inventory `localStatus = 'repartitioned'` enum value is a hold-over name from when the sync repartitioned Parquet on the way in. Today it just means "present and hash matches." Rename to `'ready'` (single source: `core/src/sync/data-inventory.ts:9`).
- The `data-management.tsx` / `data-management-org.tsx` / `data-management-tier.tsx` / `data-management-ssm.tsx` split is finer-grained than the spec implies — the spec describes "the Sync view"; the code is 4 sub-views. Either consolidate or document the split in the SPEC.

---

## How to use this document

This file is **not authoritative on what gets built**. It is a list of questions to bring into roadmap planning:

1. Is there evidence anyone uses the MCP server? → **decide.**
2. Is there evidence anyone edits `views.yaml` outside of the seed? → **decide.**
3. Add a tiny local usage counter (no telemetry leaving the machine — matches the spec's privacy stance) for the watchlist items, then revisit in a month.
4. For everything in §2, see the companion refactoring doc.

When a decision is taken (kept, dropped, deferred), update this file and the relevant feature section in [`/SPEC.md`](../SPEC.md) in the same commit.
