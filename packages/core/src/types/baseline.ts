import type { DateString, DimensionId, Dollars, EntityRef } from './branded.js';
import type { CostMetric, ExclusionRule, MarketplaceAttributionConfig } from './cost-scope.js';
import type { FilterMap } from './query.js';

/** What a baseline measures. A scope is either a selection over CostGoblin's
 *  stable built-in dimensions, or a reference to a saved View. User-tag
 *  dimensions are deliberately disallowed (enforced by the validator): tag
 *  values churn and are alias-normalized at query time, so a tag-scoped
 *  baseline would report false drift every time tags change. */
export type BaselineScope =
  | { readonly kind: 'filter'; readonly filters: FilterMap }
  | { readonly kind: 'view'; readonly viewId: string };

/** The slice of the active Cost Scope captured when a baseline is created, so
 *  recompute re-queries like-for-like even if the global Cost Scope later
 *  flips Effective↔Billed. Mirrors the build-affecting fields of
 *  {@link CostScopeConfig}. */
export interface BaselineCostBasis {
  readonly costMetric: CostMetric;
  readonly rules: readonly ExclusionRule[];
  readonly marketplaceAttribution?: MarketplaceAttributionConfig | undefined;
  readonly lagDays?: number | undefined;
}

/** Automated band + distribution stats over the historical daily series, all
 *  in $/day. The lower band deliberately excludes zero-cost days (weekends /
 *  data gaps) so the optimization floor stays achievable; every other figure
 *  uses all days. */
export interface BaselineBands {
  readonly lower: Dollars;
  readonly upper: Dollars;
  readonly median: Dollars;
  readonly mean: Dollars;
  readonly std: Dollars;
  readonly min: Dollars;
  readonly max: Dollars;
}

export type ManualBandMode = 'absolute' | 'percentile';

/** User override of either band edge. `absolute` values are $/day; `percentile`
 *  values are 0..100 and resolve against the stored series at compute time.
 *  Partial overrides are allowed — an unset edge falls back to the automated
 *  band for that side. */
export interface ManualBand {
  readonly mode: ManualBandMode;
  readonly lower?: number | undefined;
  readonly upper?: number | undefined;
}

export interface BaselineStats {
  /** ISO timestamp of the last recompute. */
  readonly calculatedAt: string;
  /** Count of daily points the bands were computed over. */
  readonly dataPoints: number;
  readonly bands: BaselineBands;
}

/** Rolling average of daily cost over a short trailing window. */
export interface BaselineCurrent {
  readonly avgDaily: Dollars;
  readonly windowStart: DateString;
  readonly windowEnd: DateString;
  readonly days: number;
}

export interface BaselineSavings {
  readonly potentialDaily: Dollars;
  readonly realizedDaily: Dollars;
  readonly potentialMonthly: Dollars;
  readonly realizedMonthly: Dollars;
}

/** Drift status derived from current vs the effective (manual-else-automated)
 *  band. `insufficient-data` when there are too few daily points or current is
 *  under a sub-cent floor. */
export type BaselineStatus = 'over' | 'under' | 'in-band' | 'insufficient-data';

export const BASELINE_STATUSES: readonly BaselineStatus[] = ['over', 'under', 'in-band', 'insufficient-data'] as const;

/** User-assignable triage status — the "ticketing" lifecycle for a baseline,
 *  independent of the auto-derived drift {@link BaselineStatus}. The funnel runs
 *  `new` → `tracking` (watching) → `acting` (optimizing now) → `resolved` (done),
 *  with two off-ramps: `dismissed` (not a worthwhile opportunity) and `ignored`
 *  (the default for low-value discovered baselines below the auto-ignore monthly
 *  threshold). The user can override any of these. */
export type BaselineTriageStatus = 'new' | 'tracking' | 'acting' | 'resolved' | 'dismissed' | 'ignored';

export const BASELINE_TRIAGE_STATUSES: readonly BaselineTriageStatus[] = ['new', 'tracking', 'acting', 'resolved', 'dismissed', 'ignored'] as const;

/** Triage states treated as still-open / actionable (the default "Open" list
 *  filter). `resolved`/`dismissed`/`ignored` are closed. */
export const OPEN_TRIAGE_STATUSES: readonly BaselineTriageStatus[] = ['new', 'tracking', 'acting'] as const;

export type BaselineSource = 'discovered' | 'manual';

export interface BaselineDailyPoint {
  readonly date: DateString;
  readonly cost: Dollars;
}

export interface BaselineNote {
  /** ISO timestamp. */
  readonly at: string;
  readonly text: string;
  readonly statusChange?: { readonly from: BaselineTriageStatus; readonly to: BaselineTriageStatus } | undefined;
  readonly ticket?: string | undefined;
}

export interface BaselineTriage {
  readonly notes: readonly BaselineNote[];
}

/** The persisted, user-authored definition of a baseline — the part that
 *  travels with config sharing (minus volatile stats/history). */
export interface BaselineSpec {
  readonly id: string;
  readonly name?: string | undefined;
  readonly source: BaselineSource;
  readonly scope: BaselineScope;
  readonly basis: BaselineCostBasis;
  /** ISO timestamp the basis snapshot was taken. */
  readonly basisSnapshotAt: string;
  readonly manualBand?: ManualBand | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A baseline as surfaced to the UI/list: the spec plus the latest computed
 *  stats, current, savings, status, and denormalized scalars for cheap
 *  sort/sum without parsing nested JSON in the hot path. */
export interface BaselineRecord {
  readonly spec: BaselineSpec;
  readonly stats: BaselineStats | null;
  readonly current: BaselineCurrent | null;
  readonly savings: BaselineSavings;
  /** Auto-derived drift status (drives the Average/Band marker color). */
  readonly status: BaselineStatus;
  /** User-assignable triage/ticketing status (defaults to `new`). */
  readonly triageStatus: BaselineTriageStatus;
  /** The effective band edges (manual-else-automated), in $/day. */
  readonly effectiveLower: Dollars;
  readonly effectiveUpper: Dollars;
  readonly currentDaily: Dollars;
  readonly potentialDaily: Dollars;
  readonly realizedDaily: Dollars;
  /** Lowest current daily ever seen since the baseline was confirmed; backs the
   *  trailing-stop reopen guard. `null` until first computed. */
  readonly bestAchieved: Dollars | null;
  /** Owning org-tree node path for account-scoped baselines, for owner grouping. */
  readonly ownerPath?: readonly EntityRef[] | undefined;
  /** Human-readable scope label (dimension values joined, or the View name). */
  readonly scopeLabel: string;
  readonly triage: BaselineTriage;
}

/** A point-in-time row written per recompute, for trend analysis. */
export interface BaselineSnapshot {
  readonly date: DateString;
  readonly lower: Dollars;
  readonly upper: Dollars;
  readonly current: Dollars;
  readonly potential: Dollars;
  readonly realized: Dollars;
  readonly status: BaselineStatus;
}

/** Full detail payload for one baseline: the record plus its stored history and
 *  snapshots. The detail chart renders entirely from `dailyHistory` — no live
 *  query. */
export interface BaselineDetail {
  readonly record: BaselineRecord;
  readonly dailyHistory: readonly BaselineDailyPoint[];
  readonly snapshots: readonly BaselineSnapshot[];
  /** The run-rate window (days) the savings band was computed over, so the UI's
   *  percentile-override preview windows the series exactly like the server. */
  readonly windowDays: number;
}

/** One contributing child dimension in the "what changed" drift breakdown. */
export interface BaselineDriftRow {
  readonly child: string;
  readonly bandWindowCost: Dollars;
  readonly currentCost: Dollars;
  readonly delta: Dollars;
}

export interface BaselinesDiscoveryConfig {
  readonly lookbackDays: number;
  readonly windowDays: number;
  readonly lowerPct: number;
  readonly upperPct: number;
  /** Discovered baselines whose average monthly cost is below this are
   *  auto-assigned the `ignored` triage status (still discovered, just hidden
   *  from the default "Open" view) — not excluded from discovery. */
  readonly minMonthlyCost: Dollars;
  readonly minSavings: Dollars;
  readonly reopenPct: number;
  /** Built-in dimension ids discovery enumerates. Empty = auto: all enabled
   *  built-ins minus high-cardinality ones. */
  readonly grainDimensions: readonly DimensionId[];
}

export interface BaselinesConfigState {
  readonly config: BaselinesDiscoveryConfig;
  readonly isCustom: boolean;
}

export type BaselineSortKey = 'potential' | 'realized' | 'current' | 'scope';

export interface BaselinesListParams {
  /** Filter by triage status. `open` = the still-open states (new/tracking/
   *  acting). Omit for all. */
  readonly triage?: BaselineTriageStatus | 'open' | undefined;
  readonly owner?: string | undefined;
  readonly dimension?: DimensionId | undefined;
  readonly sortBy?: BaselineSortKey | undefined;
  readonly sortDir?: 'asc' | 'desc' | undefined;
  readonly offset?: number | undefined;
  readonly limit?: number | undefined;
}

/** Baseline count per filter chip — every triage status plus the `open`
 *  (still-actionable) and `all` meta-buckets. Computed over all baselines,
 *  independent of the active filter, so the filter bar can show each tally. */
export type BaselineCounts = Readonly<Record<BaselineTriageStatus | 'open' | 'all', number>>;

export interface BaselinesListResult {
  readonly items: readonly BaselineRecord[];
  /** Summed over the filtered partition (discovered baselines only). */
  readonly totalPotentialMonthly: Dollars;
  readonly totalRealizedMonthly: Dollars;
  /** Total matching records before paging. */
  readonly total: number;
  /** Count per filter chip (all statuses + open + all), filter-independent. */
  readonly counts: BaselineCounts;
}

export interface BaselineCreateInput {
  readonly scope: BaselineScope;
  readonly name?: string | undefined;
}

/** Partial update applied atomically by `baselines:update`. `manualBand: null`
 *  clears the override (revert to automated); a `note` is appended to the
 *  activity log with an auto-summary of the band/status change. */
export interface BaselineUpdatePatch {
  readonly name?: string | undefined;
  readonly manualBand?: ManualBand | null | undefined;
  /** Set the triage/ticketing status; logged to the activity feed. */
  readonly triageStatus?: BaselineTriageStatus | undefined;
  readonly note?: { readonly text: string; readonly ticket?: string | undefined } | undefined;
  /** Re-snapshot the cost basis to the current active Cost Scope. */
  readonly resnapshotBasis?: boolean | undefined;
}

/** Live status of a recompute/discovery pass, pushed over the
 *  `baselines:status-changed` channel so the list refreshes as values update. */
export type BaselineRecomputeStatus =
  | { readonly state: 'idle'; readonly lastRun: string | null }
  | { readonly state: 'running'; readonly phase: 'discovering' | 'computing'; readonly done: number; readonly total: number }
  | { readonly state: 'error'; readonly message: string; readonly lastRun: string | null };
