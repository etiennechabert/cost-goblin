# Simplification: Remove Sidecar Optimization System

## Problem

The sidecar optimization system accounts for ~2,000 lines of code across 13 files (roughly 7-8% of the total codebase). It pre-computes tag columns into separate Parquet files so queries can use DuckDB's POSITIONAL JOIN instead of per-row `element_at()` map lookups on the resource_tags column.

This optimization was designed for performance, but the target workload — local analysis of AWS billing data on a desktop app — involves datasets of a few hundred MB at most. DuckDB handles `element_at()` on map columns efficiently at this scale. The sidecar system adds significant complexity across every layer of the stack for a performance gain that is imperceptible to users.

## Current Implementation

### Files involved (~2,000 LOC total)

**Desktop main process (5 files, ~600 LOC):**
- `packages/desktop/src/main/optimize.ts` (334 lines) — Main pipeline: sortRaw() reorders Parquet by date with 100k row groups, generateSidecar() creates wide Parquet with one column per tag dimension, freshness checks via mtime markers
- `packages/desktop/src/main/optimize-queue.ts` (103 lines) — Worker pool (MAX_PARALLEL=2) with deduplication and enable/disable gating
- `packages/desktop/src/main/optimize-enabled.ts` (30 lines) — Reads/writes optimizer toggle to app-preferences.json
- `packages/desktop/src/main/startup-migrate.ts` (62 lines) — Boot-time scan that enqueues all raw files needing optimization
- `packages/desktop/src/main/file-activity.ts` (70 lines) — Ring buffer (500 entries) logging file stage transitions (downloaded → sorting → sorted → building-sidecar → complete/failed)

**Query builder (partial, ~80 LOC in builder.ts):**
- `SidecarPlan` interface and `buildSourceFromSidecars()` function — generates POSITIONAL JOIN SQL
- Three-mode dispatcher in `buildSource()`: sidecar / narrowed wildcard / full wildcard
- `sidecarPlan?` optional parameter threaded through all 5 query builder functions

**IPC handlers (partial across 4 files, ~260 LOC):**
- `handlers/sync.ts` — optimize:get-enabled, optimize:set-enabled, optimize:clear-sidecars handlers + post-download enqueue
- `handlers/dimensions.ts` — tagFingerprint() detection + removeAllSidecars() + requeue on tag config change
- `handlers/query.ts` — planQuery() resolves sidecar availability per date range, logs chosen mode
- `ipc.ts` — handler registrations

**UI (2 files + preload, ~286 LOC):**
- `ui/src/components/sync-activity-indicator.tsx` (47 lines) — Spinning glyph in top nav polling optimizer status every 1.5s
- `ui/src/views/recent-file-activity.tsx` (229 lines) — Full activity panel with stage progress, enable/disable toggle, clear sidecars button
- `preload.ts` — 4 IPC methods: getOptimizeStatus, getOptimizeEnabled, setOptimizeEnabled, clearSidecars

### How it works today

1. File is downloaded → onFileDownloaded callback enqueues the raw path
2. Background queue drains with 2 parallel workers
3. Per-file: sort by date (COPY ORDER BY, 100k row groups) → generate combined sidecar (one wide Parquet with one column per tag, org-account fallback JOINed in)
4. At query time: planQuery() checks isSortFresh/isSidecarFresh for all files in the date range
5. If ALL files have fresh sidecars → buildSourceFromSidecars() with POSITIONAL JOIN
6. Otherwise → fallback to element_at() per row (the code path that always works)

### Why the complexity isn't justified

- DuckDB's element_at() on MAP columns is already fast for the data volumes involved (hundreds of MB, not TB)
- The all-or-nothing semantics mean a single stale file falls back to element_at() anyway — partial optimization never kicks in
- The system adds a background processing pipeline, filesystem-based freshness tracking, UI controls, and a three-mode query planner
- Every query builder function carries an optional `sidecarPlan?` parameter that is `undefined` most of the time
- Tag config changes trigger full sidecar invalidation + requeue, adding latency to config edits

## Proposed Change

Remove the sidecar system entirely. All queries use the `element_at()` code path (mode 2 "narrowed wildcard" and mode 3 "full wildcard" in the current buildSource).

### What to delete

1. **Delete files entirely:**
   - `packages/desktop/src/main/optimize.ts`
   - `packages/desktop/src/main/optimize-queue.ts`
   - `packages/desktop/src/main/optimize-enabled.ts`
   - `packages/desktop/src/main/startup-migrate.ts`
   - `packages/desktop/src/main/file-activity.ts`
   - `packages/ui/src/views/recent-file-activity.tsx`
   - `packages/ui/src/components/sync-activity-indicator.tsx`

2. **Simplify in builder.ts:**
   - Delete the `SidecarPlan` interface and `buildSourceFromSidecars()` function
   - Remove the sidecar branch from `buildSource()` — keep only the wildcard/narrowed paths
   - Remove the `sidecarPlan?` parameter from all 5 query builder functions

3. **Simplify in IPC handlers:**
   - Remove optimize-related handlers from sync.ts (get-enabled, set-enabled, clear-sidecars, post-download enqueue)
   - Remove tagFingerprint() and sidecar invalidation from dimensions.ts
   - Remove planQuery() sidecar resolution from query.ts — just pass undefined
   - Remove optimize handler registrations from ipc.ts

4. **Simplify preload.ts:**
   - Remove getOptimizeStatus, getOptimizeEnabled, setOptimizeEnabled, clearSidecars from the bridge

5. **Simplify App.tsx / navigation:**
   - Remove the SyncActivityIndicator from the top nav
   - Remove the file activity view from navigation

6. **Clean up on disk:**
   - First launch after update: delete the `columns/` directory under the data dir (where sidecars are stored)
   - Remove the optimize-enabled preference from app-preferences.json

### What stays

- The row-sorting optimization in DuckDB (COPY ORDER BY) could be kept independently if profiling shows it helps, but it's cleaner to remove it with the rest. DuckDB already has internal sorting heuristics.
- The `element_at()` query path — this is the existing fallback and requires zero changes.

## Migration

- No user-visible migration needed. The sidecar files on disk become orphans; a one-time cleanup on first launch deletes the `columns/` directory.
- The optimize toggle in app-preferences.json becomes a no-op; ignore it on read, stop writing it.
- The file activity UI view disappears from navigation. If users want sync visibility, the existing sync status panel covers it.

## Risks

- **Performance regression for very large datasets**: If a user has 2+ years of hourly billing data with 10+ tag dimensions, element_at() will be slower than the sidecar path. This is an edge case — most users have daily data for 3-12 months with 2-5 tags. If this becomes a real issue, the optimization can be re-added in a much simpler form (e.g., materialized views in DuckDB rather than filesystem-managed Parquet sidecars).
- **Lost file activity visibility**: The recent-file-activity panel is the only place users can see per-file optimization progress. After removal, users only see the sync status panel. This is acceptable — optimization status was niche.

## Estimated Impact

- **~2,000 lines deleted**
- **13 files removed or simplified**
- **Every query builder function signature simplified** (one fewer parameter)
- **No behavioral change for queries** — they already fall back to element_at() whenever sidecars aren't available
