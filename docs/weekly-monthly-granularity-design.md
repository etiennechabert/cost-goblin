# Weekly and Monthly granularity — design

Status: approved · 2026-10-21

## Why

Daily bars stop being readable past a few months: a year is 365 spikes, and the
trend users came to see (is spend growing, flat, seasonal?) disappears in the
noise. Users want to look at cost evolution over months and years on their
dashboards (custom views) and anywhere else the date picker appears. Today the
picker offers only Daily and Hourly, and its longest presets are "Last 365 days"
and "Last year".

Success: on a dashboard, a user picks Monthly, picks "Last 24 months", and sees
one bar per month across two years, with drag-to-zoom taking them back down to
days when they want detail.

## Goals

- Two new granularities, **Weekly** and **Monthly**, next to Hourly and Daily.
- In Weekly/Monthly mode the date picker selects **whole weeks / whole months**,
  never arbitrary days.
- Time-axis charts draw **one bar/point/column per week or month**.
- Built entirely on the existing **daily** data tier (and the daily rollups):
  no new export, no new sync tier.

## Non-goals

- **Yearly** granularity (explicitly dropped by the user).
- Weekly/monthly options in the **MCP tools** (their `tier: 'daily'|'hourly'`
  stays as is).
- Prompting users to raise **daily retention** (default 365 days). Multi-year
  views work only for users who raised it themselves; "All synced data" simply
  shows whatever is on disk.
- Special treatment of the **current, unfinished** week or month (no "partial"
  styling, no projection). It is selected and shown as a whole period like any
  other; its days without data yet simply have no cost (see "Whole periods,
  always").
- Remembering the mode or range **per dashboard**: dashboards keep opening at
  Daily / Last 30 days, as today (user's decision).

## Anti-goals

- A range switch that silently **drops data** the user was looking at.
- A mode change that leaves the user on an **empty chart** (e.g. a two-year
  range in Hourly when only 30 days of hourly data exist).
- Week/month buckets cut in the **machine's local zone**. Billing days are UTC
  (`CHARGE_PERIOD_START_UTC_SQL`); weeks and months are built from `usage_date`
  only.

## Behaviour (decided with the user)

### The switch

Four modes in the shared `DateRangePicker` toggle, ordered coarse → fine:
**Monthly · Weekly · Daily · Hourly** (user's decision; today the order is
Daily · Hourly).
Every view that shows the toggle gets the new modes: custom views
(dashboards), Explorer, Entity Detail, Missing Tags. *(Designer's call:)* views
that pass `hideHourly` today — Cost Trends and the Cost Scope preview — hide
the **whole** toggle (that is what the prop does at `date-range-picker.tsx`
~210) and keep doing so: they stay daily, unchanged by this work.

### Monthly mode picker

- Presets: Last 3 / 6 / 12 / 24 months, This year, Last year, All synced data.
- Custom range: a 12-month grid with year arrows; click a start month, then an
  end month. Months after the one holding the newest available day are
  disabled.
- The resulting `DateRange` is first-of-start-month → last-of-end-month, the
  whole month even when it isn't over (see "Whole periods, always").
- Trigger label reads e.g. `Jan 2025 – Oct 2026`.

### Weekly mode picker

- Presets: Last 4 / 6 / 12 / 26 / 52 weeks.
- Custom range: the existing day calendar, but clicking any day selects its
  whole week; the range runs from the Monday of the first week to the Sunday of
  the last week, the whole week even when it isn't over.
- Weeks are **ISO weeks** (Monday–Sunday), labelled `W42 2026` using the ISO
  week-year (so 2025-12-29 is `W1 2026` and 2027-01-01 is `W53 2026`).

### Switching modes: widen, never cut

| From | To | Range becomes |
|---|---|---|
| Daily / Hourly | Weekly | the weeks covering the current range |
| Daily / Hourly | Monthly | the months covering the current range |
| Weekly | Monthly | the months covering the current range |
| Monthly | Weekly | the weeks covering the current range (may start in the previous month) |
| Weekly / Monthly | Daily | the same days, with the end capped at the newest available day (Daily can't select days with no data yet) *(designer's call)* |
| any | Hourly | unchanged if it fits within hourly retention; otherwise the last 7 days |

No memory of the pre-widening range: Monthly → Daily does not restore Mar 15.

### Whole periods, always (user's decision)

In Weekly and Monthly mode the selected range always spans **whole** periods,
including the current one: on Oct 21, "Last 3 months" is Aug 1 → **Oct 31**,
not Aug 1 → Oct 19. Days after the newest available data simply have no cost
(queries still cap at the freshness lag, so they return nothing for them).

This makes "compare to previous period" whole periods against whole periods:
Mar 1–Oct 31 compares to Jul 1–Feb 28. Consequence the user accepted: while a
period is unfinished, its total (and any delta that includes it) is lower than
it will end up.

### Drag to zoom

Dragging across bars on a weekly or monthly chart selects those whole periods.
If the selection is short (**≤ 2 months** in Monthly, **≤ 3 weeks** in Weekly)
the view drops to **Daily** over those days. The existing rule (a ≤ 7-day drag
on a daily chart drops to Hourly) is unchanged.

### Charts and tables

- **Time-axis widgets** (stacked bar, line, heatmap) and the time charts in
  **Entity Detail** and the **Explorer** overview: one bucket per week/month,
  labels `W42 2026` / `Oct 2026`, titles "Weekly Costs" / "Monthly Costs"
  (heatmap suffix "× Week" / "× Month").
- **Non-time widgets** (pie, treemap, top-N, Pareto, price/volume, summary):
  sum the selected range from the daily tier; numbers are identical across
  Daily/Weekly/Monthly for the same range.
- **Burndown** stays daily: it tracks spend through a month.
- **Tables that group by date** (table widget's aggregated view): the date
  column becomes the week or month, with costs summed per period.
- **Compare to previous period**: the same number of whole weeks/months
  immediately before (Mar–Oct compares to Jul–Feb), not the same number of days.
- **"Last N months / weeks" presets** count the current period as one of the
  N *(designer's call)*: on Oct 21, "Last 3 months" is Aug–Oct.
- **Time-axis buckets** cover the whole selected range, so the current
  week/month gets its bar, holding only the days with data so far.
- **Remembered choice**: unchanged from today. Explorer and Entity Detail
  restore their last mode and range; dashboards always open at Daily / Last 30
  days and restore nothing (user's decision). Every view keeps writing to the
  shared prefs file as it does now.

## Constraints (from the codebase)

- `Granularity` is defined twice: `packages/core/src/types/query.ts:4` and
  `packages/ui/src/components/date-range-picker.tsx:12`. Both widen.
- The tier is chosen with `granularity === 'hourly' ? 'hourly' : 'daily'` in
  `builder.ts` (`buildCostQuery`, `buildDailyCostsQuery`,
  `buildEntityDetailQuery`) and in `query-costs.ts` / `explorer.ts` handlers.
  Weekly/Monthly must read the daily tier — and stay eligible for the daily
  **rollups** (grain includes `usage_date`, so truncation on top of it works).
- Bucket expressions to extend: `buildDailyCostsQuery` (`builder.ts` ~1035),
  `buildEntityDetailQuery` (~1215), the Explorer overview
  (`desktop/src/main/handlers/explorer.ts` ~292 raw / ~303 rollup). A shared
  helper should produce the bucket expression for all of them
  (`date_trunc('week'|'month', usage_date)` — DuckDB weeks start Monday). The
  bucket key stays the period's **start date** (`YYYY-MM-DD`) so existing
  `DailyCostDay.date` consumers keep working; labels are a UI formatting concern.
- Persisted prefs: `explorer-prefs.ts:95-96` accepts only `'daily'|'hourly'`
  and silently drops anything else — must accept the new values.
- `hasSufficientDailyCoverage` (`widgets/widget.ts:127`) compares row count to
  days × 0.8 and will reject week/month results — must count buckets instead.
- `fillDateRange` (stacked bar) fills day by day; gap filling must step by
  bucket.
- Drag-select maps bars to dates in three places: `resolveRangeSelect`
  (stacked bar), `entity-detail.tsx` ~231, `explorer.tsx` ~387. A bar's end is
  its period's end, not "next bar minus one day" at the right edge.
- `previousRangeFor` (`custom-view.tsx:77`) and `previousTrendPeriod`
  (`core/src/query/trend-change.ts:53`) shift by days/hours; need a period-aware
  variant.
- Every query handler caps the range at the freshness lag
  (`capToFreshnessLag`). Whole-period ranges reach past it on purpose; the cap
  keeps doing its job in the handlers, but the UI must not treat the capped
  range as the selection (bucket count, labels and compare come from the
  uncapped whole-period range).
- SQL rules: no interpolated values; the truncation unit comes from a closed
  union, never from user input as a string.
- `ui` imports runtime helpers from core only via `@costgoblin/core/browser`.
  Week/month math (ISO week, period start/end, widening) is pure and belongs in
  core, exported there.
- All date math is UTC (`ui/src/lib/dates.ts` is UTC-based already).

## Left to the builder

- Exact component split of the month grid and week-selecting calendar.
- Where the shared bucketing helper lives and its name.
- Label formatting details beyond the examples above (axis density, tooltips).
- Missing Tags view: shows the toggle today; whether Weekly/Monthly matter
  there beyond range picking.
