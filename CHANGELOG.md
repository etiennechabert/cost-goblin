# Changelog

Release history for CostGoblin, organized by **minor-version milestone**. Each
`v0.x.0` marks a new chunk of capability chipped into the app; the patch releases
underneath it (`v0.x.1`, `v0.x.2`, …) are the fixes and refinements that followed.

Full, auto-generated notes for every tag live on the
[GitHub Releases page](https://github.com/etiennechabert/cost-goblin/releases).

---

## 0.3.x — Configuration sharing

**Headline:** configuration is now portable. Export your dimensions, views, and
Cost Scope as a signed bundle and import it elsewhere — or publish it to an S3
"beacon" so teammates auto-discover the shared config during setup. The 0.3 line
also hardened the MCP server and fixed macOS auto-update.

- **0.3.1** — Auto-updater surfaces failures in the modal instead of silently closing (#315).
- **0.3.0** — **Configuration sharing: bundle export/import + S3 beacon discovery** (#354).
  Also: MCP `run_sql` sandboxing, Host check, and required auth token (#352);
  single mac build job that fixes broken macOS auto-update (#358); SQL
  normalization aligned with the JS rules (#353); CSV export hardened against
  spreadsheet formula injection (#351); UI stays responsive while views load (#355).

## 0.2.x — Interactive time ranges & Trends

**Headline:** click-and-drag period selection and hour-level date ranges. Drag
across any histogram to set a new range, drop into sub-day windows, and compare
to the matching previous period by the hour. The 0.2 line also grew the Trends
view, tag dimensions, and debugging tools.

- **0.2.6** — MCP tools gain a `format` parameter (markdown/json/csv) and a
  data-coverage banner; `query_missing_tags` treats placeholder values as missing (#339–#342).
- **0.2.5** — Release-pipeline fixes.
- **0.2.4** — Bubble trend gets a scale picker, empty/error states, and tunable thresholds (#313).
- **0.2.3** — Account-only tag dimensions (AWS Org account tag / OU Path), segment
  picker, the new `unit` concept, and per-dimension default filter values (#309, #310).
- **0.2.2** — Auto-updater falls back to a full download when a differential update fails (#305).
- **0.2.1** — Top-menu consolidation, an "All" direction for Trends, origin-tagged
  Debug-panel queries, and a cache-clear button (#296–#298).
- **0.2.0** — **Click-and-drag period selection + hour-level date ranges** (#275, #281).
  Also: cross-chart hover sync, a 16-color chart palette, and Data Management polish.

## 0.1.x — First public release

**Headline:** the app itself — S3 billing sync, DuckDB-powered queries, the
interactive dashboard, and the MCP server. The 0.1 line got CostGoblin packaged,
signed, auto-updating, and shipped.

- **0.1.8** — Bubble chart handles negative values; configurable log scale (#273).
- **0.1.7** — Update-notification UX overhaul (auto-open dialog, HTML release notes, progress bar) (#272).
- **0.1.6** — AI Assistant view and clickable group-by dimensions; **vault /
  encryption-at-rest removed** in favor of plain Parquet (#268, #270, #271).
- **0.1.5** — AWS CLI detection & guided setup; SSO login fixed in packaged builds (#262, #263, #265).
- **0.1.4** — Auto-update check on startup; SSO login button in the setup wizard (#260, #261).
- **0.1.2** — Landing-page layout fix; macOS signing-workflow consolidation (#259).
- **0.1.1** — macOS code signing & notarization via a scoped `release` environment (#258).
- **0.1.0** — **First public release.** S3 sync, DuckDB queries, interactive
  dashboard, period-over-period comparison, missing-tags view, MCP server,
  command palette, and SQL-injection hardening.
