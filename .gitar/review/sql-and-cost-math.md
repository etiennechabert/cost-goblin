# SQL and cost math

Covers `packages/core/src/query/`, `packages/core/src/normalize/`, `packages/core/src/rollup/`, `packages/core/src/baseline/`, `packages/mcp/src/tools/` and the query handlers in `packages/desktop/src/main/handlers/`. CLAUDE.md's "SQL Security" covers injection. These are the correctness checks it leaves out.

## Building SQL

- Dimension ids from the renderer, a config or MCP reach SQL only through `resolveField` or `tryResolveField`. Rule conditions may skip an unknown id; filters and group-bys must throw. Other columns come from fixed allow-lists, so extend the list rather than interpolating.
- A tag's id is not its SQL column, because DuckDB identifiers are case-insensitive even when quoted. SQL uses `tagSqlColumn`. The persisted `tagDimColumn` form, stored in views, baselines and bundles, must keep its format (`packages/core/src/types/branded.ts`).
- DuckDB can't prepare DDL (`CREATE … AS`, `COPY … TO`). The rollup and grain-probe builders therefore inline escaped literals after `assertBillingPeriod` / `assertDateString`, and a `$n` placeholder in DDL stays unbound.
- Bound integers are int32 (`bindInteger` in `packages/desktop/src/main/duckdb-worker.ts`), so epoch milliseconds, byte counts and large thresholds overflow.
- `toNum` decodes only numbers and bigints: a DECIMAL result becomes 0 with no error. Cost columns are DOUBLE by contract, and hand-written aggregates need `CAST(SUM(…) AS DOUBLE)`.
- A new raw FOCUS column in `buildSource` goes into `packages/core/src/sync/focus-contract.ts`, and `packages/core/src/sync/gcp-canonicalize.ts` must produce it, or GCP months fail to bind. Keep `union_by_name=true` and the table prefix on raw columns.
- Intersect every glob with the months that provider actually has on disk: one glob matching nothing fails the whole UNION.

## NULLs and missing values

- Built-in columns are COALESCEd to `''` and a missing account becomes `'(no account)'`, but a tag column is NULL when the tag is absent.
- `NOT`, `NOT IN` and `!=` over a tag expression drop untagged rows, from queries and from stored rollups alike. Exclusions and their previews must share one NULL-safe expression.
- SQL built from a list must handle the empty list, because `IN ()` doesn't parse.
- `''` names the group with no value, and results read NULL as `''` (`toStr`), so a tag's untagged (NULL) and empty-valued rows must be one group. A filter on `''` goes through `missingValueSql`, since `field = ''` drops the NULL rows. Elsewhere, group, count, sort and match a tag as `COALESCE(col, '')`, or sum the rows that read alike: a raw GROUP BY returns two `''` rows, and JS that keeps the first, overwrites by key or lets a top-N page cut one of them loses cost. The aggregated table's own GROUP BY (`packages/desktop/src/main/handlers/aggregated-table.ts`) is a known open case (#738); flag new ones.
- JS reads NULL as 0, and a NULL ratio (say, percent change from a zero baseline) drops the row when compared with a threshold. COALESCE skips NULL, not 0.

## Cost semantics

- The default metric is EffectiveCost. Use `DEFAULT_COST_METRIC`, not a literal, so the rollup's signature and build agree. `list` and `contracted` count only `ChargeCategory = 'Usage'` rows, or commitments count twice (`packages/core/src/query/cost-metric.ts`).
- Credits and refunds are negative and net into every SUM, so a percent change divides by the baseline's absolute value. Dropping non-positive totals must be deliberate and say why.
- Currencies are never converted, so don't add math that assumes a single one.
- A hand-built source must apply the whole cost scope (metric, marketplace attribution, exclusions) or state why not. Otherwise one dropdown shows different dollars before and after the rollup is ready.

## Dates

- `usage_date` is the naive-UTC `ChargePeriodStart` cast to DATE, and the DuckDB session time zone isn't pinned, so TIMESTAMPTZ input would shift days. Day math in JS is UTC-only.
- Ranges are inclusive (`BETWEEN`). Compare DATE with DATE: an hourly timestamp compared with a date drops most of the last day.
- A handler or MCP tool caps its range at the cost scope's `lagDays` (`capToFreshnessLag`, `resolveToolDateRange`) before building SQL, and returns empty when nothing is left; the SQL builders never apply it. The Explorer with "Apply cost scope" off is the one exception. Main-process "now" comes from `IpcContext` or `McpContext`, never `Date`.
- The trends previous-period window exists three times, in JS and SQL in `packages/core/src/query/builder.ts` and in `packages/desktop/src/main/handlers/query-trends.ts`. Keep them aligned.

## Rollups

- A rollup bakes in the metric, enabled exclusions, the marketplace rewrite and the tag projection, while aliases apply at query time. Queries over it add no exclusions, but the date filter must appear on both paths.
- Route a query to the rollup only for a single provider, the daily tier, no hour bounds, valid periods and the global cost scope, and only when every column the SQL touches is in `neededColumns`. A request with its own cost basis compares `computeShapeSignature` or stays on raw.
- Anything that changes stored bytes goes into `packages/core/src/rollup/shape-signature.ts` or bumps `ROLLUP_SCHEMA_VERSION`.
- The result cache is keyed on SQL text and parameters. An input that changes results but not the SQL (newly synced files, org accounts, account or region maps) must clear it.

## Normalization

- `buildAliasSqlCase` in SQL and `normalizeTagValue` plus `resolveAlias` in JS must agree. Filter values, defaults and org-tree names are already canonical; rule values are raw and get normalized in JS first.
- Query handlers use `getQueryDimensions()`, which merges the region aliases. `getDimensions()` is for the editor.

## Tests

SQL-shape tests built on `toContain` don't prove behavior: the NULL-exclusion bug passed them. A change to what SQL returns needs a test executed in DuckDB, like `packages/core/src/__tests__/normalize-sql.test.ts`, `packages/core/src/__tests__/sql-escaping.integration.test.ts` or `packages/core/src/__tests__/rollup-invariant.test.ts`.
