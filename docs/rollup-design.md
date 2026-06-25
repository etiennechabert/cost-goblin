# Dashboard Rollup — Design

> Status: design agreed (2026-06). Backed by Phase 0 measurements on real data
> (14 mo daily, `costMetric=list`, 5 exclusion rules, 16 threads, 68 GB RAM).

## 1. Goal

Dashboard widgets currently query raw Parquet directly, and raw query time
**scales with the window** — measured ~0.65 s (30-day) up to ~12 s (365-day) for
a *single* widget. That's too slow for a multi-widget dashboard, and it gets
worse the further back you look.

A **rollup** — a small, pre-aggregated, on-disk derivative of the raw data —
serves those same queries in **~50–170 ms regardless of window** (13× faster at
30 days, up to **72× at 365 days** — see the Appendix for the confirmed
benchmark). The split:

- **Dashboard widgets → the rollup.**
- **Cost Explorer + the Table widget → raw.**

One data path per surface. This is deliberate: it bounds the rollup's
responsibilities and therefore the bug surface.

## 2. What the rollup is (and is not)

It is a **per-period, pre-aggregated Parquet partition set**:

- **Per-period**: one partition per month, mirroring the raw layout
  (`aws/raw/daily-YYYY-MM/` → `aws/rollup/daily-YYYY-MM/`). Each partition is
  built independently. This is the single most important decision — see §3.
- **Pre-aggregated**: grouped to `(usage_date × enabled dashboard dimensions)`,
  with the active cost metric/perspective **baked into a `cost` column** and
  exclusion rows already dropped. Not line-item grain.
- **On disk**: the partitions *are* the persisted artifact. There is no separate
  in-memory `cost_base` table to rebuild on every launch.

It is **not** a line-item table (that's the raw data, served by Explorer), and
it is **not** a single monolithic in-memory build (that was the source of the
7.7-min / 100M-row spill in early measurement).

### Grain

`usage_date` + every **enabled** dimension column + measures (`SUM(cost)`,
`COUNT(*) AS line_items`). Dimension values are stored **raw** (un-aliased) —
aliasing stays query-time (§7).

- Default-enabled dims: `account_id`, `account_name`, `service`,
  `service_family`, and the configured tag dims (`team`, `system`, `env`,
  `unit`).
- `usage_type` is **off by default** (it ~4×'s the rollup and is hard to read),
  but **user-enablable** — enabling it is a shape change (§4) that re-rolls and
  restores the 3rd pie level.
- `resource_id`-class ultra-high-cardinality dims are **raw-only** (§6): never in
  the rollup; widgets grouping by them fall back to raw. Enforced by the
  estimator threshold (§8), not a hardcoded list.

## 3. Why per-period (the load-bearing decision)

Building the whole window in one in-memory CTAS materialized ~100M wide rows
(with ARNs) and spilled to disk → 7.7 min. Building **one partition per month**:

- **No spill** — each build holds ~one month, aggregates, writes, releases.
- **Is the incremental primitive** — a sync that changes month M re-rolls *only*
  M's partition (a file replace), not the world.
- **Makes persistence free** — partitions are files; warm-load = glob them.
- **Parallelizable** — independent month builds across the connection pool.

Measured (12 months, grain incl. `usage_type`): per-month build 2–11 s, **~83 s
sequential** (parallelizable to ~20 s), **266 MB** total (vs 4.1 GB line-item,
15 GB raw), 19.6M rows. Without `usage_type` (the default): **~85 MB**, 5.5M rows.

> Note: per-month build time climbed within a single long-lived connection
> (buffer accumulation). Use a fresh connection (or reset) per period to keep
> each ~2 s.

## 4. Physical layout & manifest

```
data/processed/aws/
  raw/daily-YYYY-MM/*.parquet          # existing
  rollup/
    manifest.json                      # written last, temp-then-rename (atomic)
    daily-YYYY-MM/rollup.parquet       # one partition per month
```

`manifest.json`:

```jsonc
{
  "schemaVersion": 1,                  // code-owned; bump invalidates all
  "shapeSignature": "<digest>",        // see below
  "partitions": {
    "2026-05": { "rawEtagHash": "<hash of that month's raw etag-set>",
                 "rows": 1750000, "bytes": 24117248 }
  }
}
```

### Shape-signature (the correctness keystone)

A digest over **shape-affecting inputs only**. If it matches the current config,
the partitions are trusted as-is. If not, they're stale → re-roll.

**In the signature** (changing these changes stored bytes):
- the set of enabled dimension columns + their projection
  (`tagName` / `accountTagFallback` / `missingValueTemplate` / `pathSegment`)
- `costMetric`, `costPerspective`
- the enabled exclusion-rule set
- a digest of `org-accounts.json` content (feeds the account-fallback join)
- the available-columns probe result

**Excluded** (query-time — see §7): value aliases, normalize, `lagDays`,
dimension `label` / `order` / `defaultFilterValues` / `enabled`-cosmetic, region
friendly-names. One carve-out: an alias/normalize value referenced by an
**enabled exclusion rule** *is* baked → in the signature.

> Today `getSource` ([materialized-base.ts](../packages/desktop/src/main/materialized-base.ts))
> gates only on tier + date range, and `configHash` wrongly includes `lagDays`.
> Both must change (§9, Phase 1).

## 5. Lifecycle

| Stage | Trigger | Action |
|---|---|---|
| **Cold build** | first run / no valid manifest | build the recent partition(s) first, background the rest |
| **Warm-load** | restart with manifest present | **validate** (shape-signature + per-partition `rawEtagHash`); match → serve instantly, no rebuild; mismatch → flag for background re-roll |
| **Incremental** | sync changes month M | re-roll **only** M's partition (file replace), update its watermark, invalidate the dashboard query cache for that range → widgets re-render |
| **Config/metric regen** | shape-signature change | background re-roll all partitions; serve old/stale meanwhile |
| **Serving** | any dashboard query | route to rollup glob if covered + signature valid + columns present; else raw (§6) |
| **Eviction** | new signature / startup sweep | keep current signature's partitions; delete orphans |

**No app block, ever.** Normal restart globs existing partitions and serves
instantly. The only "not ready" cases (first run, config/metric change, raw
changed since roll, corruption) trigger a **background** re-roll with a
per-widget loading state — the rest of the app stays usable.

While a partition re-rolls, widgets show **the old partition's numbers with an
"updating…" badge** (fast, slightly stale); a true first build shows a loading
state. (Policy — revisit.)

## 6. Routing: rollup vs raw

**Rollup** (the dashboard widgets): summary / pie / treemap / top-N bar
(`queryCosts`), line / stacked / heatmap (`queryDailyCosts`, daily only),
bubble / trends (when the window covers the compare period too), entity-detail,
and filter-value lists — all at daily granularity, over enabled-dim grain.

**Raw** (always):
- **Cost Explorer** — independent metric/perspective toggles, full line-item schema.
- **The Table widget** — needs `resource_id` / `description` / raw row counts /
  CSV. It's Explorer-grade; it stays on raw and is the **last widget to load**.
- **Hourly / sub-day** (drag-zoom) — the rollup is daily.
- **Any group-by on a raw-only dim** (`resource_id`, …).

The routing decision is **per-query-shape**, not per-widget.

## 7. What stays query-time (never baked)

Stored raw in the partition; applied per query so edits take effect immediately
without a rebuild:

- **value aliases & normalize** — `buildAliasSqlCase` over the stored raw column
  (today: [builder.ts](../packages/core/src/query/builder.ts) `tryResolveField`).
- **account_id → account_name** display resolution and org-tree rollup (JS,
  post-query).
- **`lagDays`** — a query-window filter; changes zero stored bytes.
- **cosmetic dimension fields** — label, order, defaultFilterValues.

## 8. Grain cost/benefit estimator

When the user toggles a dimension, show the impact **before** committing the
(background) rebuild.

- **Current grain: exact.** The rollup is on disk — sum partition rows/bytes.
- **Candidate grain: estimated.** Keep a small **probe** (a recent month, all
  candidate dim columns) and run
  `approx_count_distinct(concat_ws('\x1f', <grain cols>))` per day × window days.
  Measured: **~150–550 ms** (interactive).
- **Accuracy is directional, not exact**: ~−10% on stable grains, ~+35% on
  high-cardinality dims (recent months over-represent them; not fixable by a
  bigger recent probe). That's fine — present **bands**, not false precision, and
  the real number lands after the rebuild. Show: estimated size band, compression
  rate (line-item rows ÷ rollup rows), and rebuild-time band.
- **Raw-only flagging**: if a candidate dim's estimate crosses a threshold
  (e.g. >2× current rollup, or a partition >50 MB), suggest **raw-only** instead
  of bloating the rollup. This is how `resource_id` is handled — data-driven, not
  a hardcoded list.
- *Optional later:* a one-time stratified multi-month probe (~20–30 s) removes
  the recent-bias if tighter numbers are ever wanted.

## 9. Phased implementation

**Phase 1 — correctness of the existing in-memory base (ships alone).**
- `getSource` hard-gates on a **shape-signature**, not tier+range.
- Narrow the signature (exclude alias/normalize/`lagDays`/cosmetics; add the
  exclusion-rule alias carve-out; add org-accounts + column-probe).
- Single-writer queue + epoch tokens for all rollup mutations (kills the
  `drop()`-vs-in-flight-`materialize()` resurrection + concurrent-rebuild races).
- **Fix the Table-widget bug**: it runs on the Explorer handlers inside the
  dashboard and silently defaults to `unblended` — pass it the global scope.

**Phase 2 — per-period maintainer.**
Thread the changed-period set (already computed by `auto-sync`) into a
`maintainRollupForPeriods()` that does transactional replace-by-period, keyed off
per-period sync-etag success. Wire `data:delete-period`. Ingest all days; apply
`lagDays` at query time.

**Phase 3 — pre-aggregated on-disk partitions + manifest.**
Move from the in-memory `cost_base` to `aws/rollup/daily-YYYY-MM/` partitions at
the enabled-dim grain; atomic manifest; warm-load + validation; orphan sweep.
Route dashboard queries to the partition glob; warm filter-values from it at
startup (retires the "Loading dimensions N/8" hang).

**Phase 4 — estimator UI + raw-only flagging** (§8).

## Appendix — Confirmed benchmark

Measured on real data (16 threads, 69 GB RAM; `costMetric=list`, 5 exclusion
rules; 12 daily months 2025-07…2026-06). **Reproducible** via
`scripts/rollup-bench.mts`:

```
COSTGOBLIN_DATA_DIR=…/data/processed COSTGOBLIN_CONFIG_DIR=…/data/config \
  npx tsx scripts/rollup-bench.mts
```

It builds the partitions to a temp dir (never touching your data), times raw vs
rollup, and asserts rollup totals match raw.

**Build & size**

| | Result |
|---|---|
| Per-month build (cold) | median **7.7 s**, max 10.7 s |
| Full 12-month build (sequential) | **83.7 s** (parallelizable — #383) |
| Rollup size, 12 mo | **266 MB** / 19.6M rows — **4.4% of the 6.0 GB raw** |
| Correctness | rollup total == raw total, **0.0000% diff** |

**Query latency — raw Parquet vs rollup glob** (identical window + scope)

| Window | Query | Raw | Rollup | Speedup |
|---|---|---|---|---|
| 30-day | cost by service | 0.65 s | 49 ms | **13×** |
| 30-day | daily by service | 2.56 s | 49 ms | **52×** |
| 365-day | cost by service | 3.54 s | 99 ms | **36×** |
| 365-day | daily by service | 11.96 s | 166 ms | **72×** |

The defining property: rollup query time is **~constant (~50–170 ms) across
window size**, while raw scales with the months scanned. Sizes are with
`usage_type` in the grain (the real config); dropping it (#380) cuts the rollup
to ~85 MB. Estimator (deferred, #381): probe ~150–550 ms, directional accuracy
(≈ −10% stable grains, ≈ +35% high-cardinality — present as bands).
