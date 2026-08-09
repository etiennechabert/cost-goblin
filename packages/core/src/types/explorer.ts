import type { CostMetric } from './cost-scope.js';
import type { DateRange, Granularity } from './query.js';

/** Multi-value filter for the Explorer. Each key is a dimension id, each
 *  array is the set of values the user has picked (OR within a dimension,
 *  AND across dimensions). Empty arrays are no-ops. */
export type ExplorerFilterMap = Readonly<Record<string, readonly string[]>>;

export type ExplorerSortDirection = 'asc' | 'desc';

/** Column id is either a built-in dimension column (e.g. `cost`, `service`,
 *  `usage_date`) or a tag column (e.g. `tag_team`). The handler maps it to
 *  the underlying SQL expression. */
export interface ExplorerSort {
  readonly column: string;
  readonly direction: ExplorerSortDirection;
}

/** Shared across both overview + rows queries — the axes that both
 *  respond to. Sort + rowLimit are rows-only. */
export interface ExplorerBaseParams {
  readonly filters: ExplorerFilterMap;
  /** Inclusive day range the query covers. Defaults server-side to the
   *  last 30 days ending yesterday when omitted. */
  readonly dateRange?: DateRange;
  /** Which tier to query. `hourly` reads the hourly Parquet directory and
   *  exposes a `usage_hour` timestamp per row. Defaults to `daily` — the
   *  hourly tier is opt-in and may not be synced. */
  readonly granularity?: Granularity;
  /** When true, apply the saved Cost Scope's exclusion rules as a WHERE
   *  filter. Default false — the Explorer exists to inspect the raw
   *  dataset, so hiding Tax / Credits / RI purchases by default defeats
   *  the purpose. User opts in via a toggle to compare with other views. */
  readonly applyCostScope?: boolean;
  /** Which FOCUS cost column backs the `cost` field. When omitted, the
   *  server inherits the Cost Scope's metric if `applyCostScope` is set,
   *  else falls back to `billed` (the invoice-faithful metric matching the
   *  Explorer's raw-inspection intent). All four metrics are always
   *  available in a FOCUS export. */
  readonly costMetric?: CostMetric;
  /** Debug-only: tag identifying which widget/view fired this query. */
  readonly origin?: string | undefined;
}

export type ExplorerOverviewParams = ExplorerBaseParams;

export interface ExplorerRowsParams extends ExplorerBaseParams {
  readonly sort?: ExplorerSort;
  /** Cap on returned sample rows. Clamped server-side to avoid IPC blowup. */
  readonly rowLimit: number;
}

export interface ExplorerDailyRow {
  readonly date: string;
  readonly cost: number;
  readonly rows: number;
}

export interface ExplorerSampleRow {
  readonly date: string;
  /** ISO timestamp when the query ran against the hourly tier, else empty. */
  readonly hour: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly region: string;
  readonly service: string;
  readonly serviceCategory: string;
  readonly chargeCategory: string;
  readonly operation: string;
  readonly skuMeter: string;
  readonly description: string;
  readonly resourceId: string;
  readonly usageAmount: number;
  readonly cost: number;
  readonly listCost: number;
  readonly tags: Readonly<Record<string, string>>;
}

export interface ExplorerTagColumn {
  readonly id: string;
  readonly label: string;
}

/** The "static" slice of the Explorer result — daily histogram + totals.
 *  Driven only by filters/range/scope/metric, so it doesn't
 *  refresh when the user changes the table sort. Paired with
 *  ExplorerRowsResult which handles the sortable rows. */
export interface ExplorerOverviewResult {
  readonly windowDays: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly dailyTotals: readonly ExplorerDailyRow[];
  /** Underlying charge-row count matching the filters (before the
   *  rows sample cap). The UI shows "N of M rows" honestly. */
  readonly totalRows: number;
  readonly totalCost: number;
  /** Names of configured tag dimensions in the order the UI should render
   *  them as columns. The same list is echoed on ExplorerRowsResult so a
   *  consumer reading only one has what it needs. */
  readonly tagColumns: readonly ExplorerTagColumn[];
}

export interface ExplorerRowsResult {
  readonly sampleRows: readonly ExplorerSampleRow[];
  readonly tagColumns: readonly ExplorerTagColumn[];
}

export interface AggregatedTableParams extends ExplorerBaseParams {
  readonly groupByColumns: readonly string[];
  readonly sort?: ExplorerSort;
  readonly rowLimit: number;
  readonly rowFilters?: Readonly<Record<string, string>> | undefined;
}

export interface AggregatedTableRow {
  readonly values: Readonly<Record<string, string>>;
  readonly cost: number;
  readonly listCost: number;
  readonly usageAmount: number;
  readonly rowCount: number;
}

export interface AggregatedTableResult {
  readonly rows: readonly AggregatedTableRow[];
  readonly totalRows: number;
  readonly tagColumns: readonly ExplorerTagColumn[];
}

export interface ExplorerFilterValue {
  readonly value: string;
  readonly label: string;
  readonly cost: number;
  readonly rows: number;
}

/** Columns the Explorer hides until the user makes a column choice. The
 *  desktop `explorer:get-preferences` handler returns this set when no
 *  preferences file exists (or its `hiddenColumns` field is unreadable), and
 *  the UI seeds its pre-load state from it — a persisted `hiddenColumns: []`
 *  is the user's explicit "Show all" and is honored as-is. Shared through
 *  core so the two sides can't drift. */
export const DEFAULT_EXPLORER_HIDDEN_COLUMNS: readonly string[] = [
  'usage_hour', 'list_cost', 'service', 'usage_amount', 'operation',
];

/** Persisted user preferences for the Explorer view. Stored as a JSON file
 *  in the userData dir (same pattern as SavingsPreferences). */
export interface ExplorerPreferences {
  /** Column keys the user has hidden. Stored as "hidden" not "visible" so
   *  that columns added in future updates become visible automatically —
   *  users don't have to re-enable them. */
  readonly hiddenColumns: readonly string[];
  /** User-chosen display order for the table columns. Keys that exist in
   *  this list are rendered in the given order; columns not present
   *  (e.g. a newly-added built-in, or a tag the user enabled after
   *  reordering) are appended afterwards in their default order. */
  readonly columnOrder: readonly string[];
  /** Last date range the user selected. Persisted so the view opens with
   *  the same range on the next session. */
  readonly lastUsedDateRange?: DateRange;
  /** Last granularity the user selected (`daily` or `hourly`). Persisted
   *  so the view opens with the same granularity on the next session. */
  readonly lastUsedGranularity?: Granularity;
  /** Whether the "compare to previous period" toggle is on. */
  readonly compareEnabled?: boolean;
}

/** A partial update to the persisted Explorer preferences. Every field is
 *  optional: the persistence layer merges an update onto whatever is already
 *  on disk, so an omitted field is preserved rather than cleared.
 *
 *  This matters because several views persist to the *same* file. Only the
 *  Explorer manages column visibility; the others persist just a date range /
 *  granularity and therefore OMIT `hiddenColumns` / `columnOrder`. Merging
 *  preserves the user's curated column set, so a date-range save can never
 *  silently clobber it (e.g. by writing `[]`, which reads back as the
 *  explicit "Show all"). See `writeExplorerPreferences` for the enforcement.
 *
 *  Derived from `ExplorerPreferences` rather than restated, so a field added
 *  there can never be silently unsavable here. */
export type ExplorerPreferencesUpdate = Partial<ExplorerPreferences>;

export interface ExplorerFilterValuesParams {
  readonly dimensionId: string;
  readonly filters: ExplorerFilterMap;
  readonly dateRange?: DateRange;
  readonly granularity?: Granularity;
  /** Same as `ExplorerQueryParams.applyCostScope` — lets the dropdown
   *  counts reflect whatever scope the user is looking at. Default false. */
  readonly applyCostScope?: boolean;
  readonly costMetric?: CostMetric;
  readonly origin?: string | undefined;
}
