# Refactoring Targets — 2026-05

A list of places in the codebase where the design has accumulated responsibilities or duplication and a small, mechanical refactor would pay back. Companion to [`feature-audit.md`](feature-audit.md) and [`/SPEC.md`](../SPEC.md).

> Ordering is by **ROI** — biggest payback first, lowest risk first within the same payback. None of these are urgent; treat the list as a backlog the next time someone has slack to clean up.

---

## 1. Big files to split (UI views)

These are single React components that accumulated multiple unrelated concerns. The pattern in each case is the same: pull out subtrees as standalone components colocated in the same view folder.

### `packages/ui/src/views/dimensions.tsx` — ~1.8k LOC
Combines:
- Drag-drop reordering of dimensions.
- Alias editing (text in / typed config out).
- Normalization preview.
- Locked built-in dimensions (service, service_family, usage_type) + the migration that backfills old `enabled: false` entries.
- Smart alias suggestions plumbing (`getAliasSuggestions` / `acceptSuggestion` / `dismissSuggestion`).

**Proposed split:**
- `DimensionList` — the reorderable list (drag-drop only).
- `AliasEditor` — text-area parser, the canonical row.
- `NormalizationPreview` — sample values + before/after.
- `AliasSuggestionPanel` — the smart-suggestions block.
- A small `dimensions-migration.ts` for the built-in backfill logic so it's testable in isolation.

### `packages/ui/src/views/cost-scope.tsx` — ~1.09k LOC
Combines: rule builder + preview + sample + metric selector.

**Proposed split:** extract `RulePreview` (rows kept vs. dropped + dollar delta) and `MetricSelector` (with capabilities gating). The rule list itself can stay in the parent.

### `packages/ui/src/views/explorer.tsx` — ~1.09k LOC
Combines: table + sort + filter chips + histogram brush-select + hourly toggle.

**Proposed split:** extract a `useBrushDateRange` hook (already partly factored as `use-bar-drag-select.ts`); move the column model to a config object instead of inline JSX; keep the parent as a layout-only component.

### `packages/desktop/src/renderer/App.tsx` — ~890 LOC
Combines: router + layout + top nav + view switching + theme/palette loading.

**Proposed split:** `<TopNav>` and `<Router>` as siblings; theme/palette loading into a `usePreferencesBootstrap` hook.

---

## 2. Big files to split (desktop main / core)

### `packages/desktop/src/main/handlers/explorer.ts` — ~700 LOC
15+ IPC registrations across rows, overview, daily, aggregated table, sampling. Split per query type:
- `explorer/rows-handler.ts`
- `explorer/overview-handler.ts`
- `explorer/aggregated-handler.ts`
- `explorer/sample-handler.ts`

### `packages/desktop/src/main/handlers/context.ts` — ~595 LOC
Mixes bootstrap (`AppContext` construction, config merging, built-in dimension backfill, legacy label migration) and runtime lookup. Pull the migration / backfill into `context-migration.ts`; keep `context.ts` for construction + lookup.

### `packages/desktop/src/main/handlers/query-utils.ts` — ~482 LOC
40+ utility functions with no clear cohesion. Concrete win: `mergeCostRowsByEntity` and `mergeTrendRowsByEntity` are near-duplicates that should collapse into one generic:

```ts
function mergeRowsByEntity<T extends { entity: string }>(
  rows: readonly T[],
  reduce: (a: T, b: T) => T,
): T[]
```

Then split the file by concern: `entity-merge.ts`, `period.ts`, `effort.ts`, `account-reverse-map.ts`.

### `packages/core/src/query/builder.ts` — ~897 LOC
Six query types share one string-concatenation builder; adding a query touches every helper. Two paths forward:

- **Light:** factor the per-query bodies (`buildCostQuery`, `buildTrendQuery`, …) into their own files and share `field-resolution.ts` + `param-builder.ts` + `cost-scope-where.ts`.
- **Heavier:** introduce a small SQL AST (select / from / where / group / order) and let each query builder emit it. Probably overkill until there's a 7th or 8th query type.

Start with the light path. The AST is a future option, not a near-term need.

---

## 3. Cross-cutting cleanups

### Single source of truth for dimension field resolution
Field resolution (mapping a `DimensionId` to a column expression) is reimplemented in:
- `packages/core/src/query/builder.ts` (`tryResolveField` etc.)
- `packages/desktop/src/main/handlers/context.ts`
- `packages/desktop/src/main/handlers/dimensions.ts`

Move to one `resolveField` exported from `core/src/query/` and have the others import it. Right now the allow-list lives implicitly in the builder.

### Type-assertion debt — small but visible
| File | Cast | Verdict |
|------|------|---------|
| `packages/desktop/src/main/duckdb-worker.ts:12` | `as unknown as DuckDBModule` on dynamic import | Upstream type bug; leave as-is. |
| `packages/mcp/src/http-server.ts:81` | `as unknown as Transport` for SDK callback | Upstream MCP-SDK type bug; leave as-is. |
| `packages/desktop/src/main/handlers/dimensions.ts:363` | `as unknown[]` for runtime input | **Replace with a real type guard.** |
| `packages/ui/src/__tests__/keyboard-shortcuts.test.ts:6` | `as unknown as KeyboardEvent` | Test mock; leave or use a proper `KeyboardEvent` constructor. |

The codebase otherwise honors the no-`as` rule from `CLAUDE.md`; these are the four exceptions.

### Stale enum: `localStatus: 'repartitioned'`
See [`feature-audit.md`](feature-audit.md#5-pure-consistency--cleanup-notes). Rename to `'ready'` — the value is misleading now that sync writes raw Parquet directly.

### Dead component
`packages/ui/src/components/concept-placeholder.tsx` exists but isn't imported anywhere. Either restore the "grayed concept widget" UX described in `/SPEC.md` → Default View, or delete the file.

---

## 4. Suggested ordering (when slack appears)

A sketch of how to sequence the above so each step is small enough to land in a single PR and doesn't block the next one.

1. **`query-utils.ts` merge-helper unification** — half a day; lowest blast radius. Warm-up for #2.
2. **`builder.ts` light split** (per-query files + shared helpers) — one day. Stops the file from growing.
3. **`dimensions.tsx` split** — one to two days. Biggest LOC win, fully self-contained, doesn't touch query paths.
4. **`cost-scope.tsx` split** — one day. Same recipe as dimensions.
5. **`explorer.ts` handler split** — half a day. Mechanical; the IPC channels don't change names.
6. **`App.tsx` router/nav extract** — half a day.
7. **Cross-cutting cleanups** — single field resolution, kill the dead `ConceptPlaceholder`, rename `repartitioned` — a single small PR.

Stop and re-evaluate after #2. The picture may change once the query builder is easier to read.

---

## What this document is *not*

- Not a commitment to refactor any of this.
- Not a deletion list — see [`feature-audit.md`](feature-audit.md) for the value-vs-complexity discussion.
- Not exhaustive — every codebase has more of this kind of thing than is worth listing. These are the items where the payoff is high enough to write down.
