import type { DateString, DimensionId, Dollars, EntityRef, TagValue } from './branded.js';

export type Granularity = 'daily' | 'hourly';

export interface DateRange {
  readonly start: DateString;
  readonly end: DateString;
}

export type FilterMap = Readonly<Partial<Record<DimensionId, TagValue>>>;

export interface CostQueryParams {
  readonly groupBy: DimensionId;
  readonly dateRange: DateRange;
  readonly filters: FilterMap;
  readonly granularity?: Granularity | undefined;
  readonly orgNodeValues?: readonly string[] | undefined;
}

export interface CostRow {
  readonly entity: EntityRef;
  readonly totalCost: Dollars;
  readonly serviceCosts: Readonly<Record<string, Dollars>>;
  readonly isVirtual?: true | undefined;
}

export interface CostResult {
  readonly rows: readonly CostRow[];
  readonly totalCost: Dollars;
  readonly topServices: readonly string[];
  readonly dateRange: DateRange;
}

export interface TrendQueryParams {
  readonly groupBy: DimensionId;
  readonly dateRange: DateRange;
  readonly filters: FilterMap;
  readonly deltaThreshold: Dollars;
  readonly percentThreshold: number;
}

export interface TrendRow {
  readonly entity: EntityRef;
  readonly currentCost: Dollars;
  readonly previousCost: Dollars;
  readonly delta: Dollars;
  readonly percentChange: number;
}

export interface TrendResult {
  readonly increases: readonly TrendRow[];
  readonly savings: readonly TrendRow[];
  readonly totalIncrease: Dollars;
  readonly totalSavings: Dollars;
}

export interface MissingTagsParams {
  readonly dateRange: DateRange;
  readonly filters: FilterMap;
  readonly minCost: Dollars;
  readonly tagDimension: DimensionId;
}

/**
 * Classification of an untagged resource line:
 *   - 'actionable'          → other resources in the same (service, service_family)
 *                             category ARE tagged, so this one is taggable and
 *                             missing. The work queue.
 *   - 'likely-untaggable'   → no resource in the same category has ever been
 *                             tagged in the dataset. Either AWS doesn't allow
 *                             it or the org never has. Hidden by default.
 */
export type MissingTagBucket = 'actionable' | 'likely-untaggable';

export interface MissingTagRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly resourceId: string;
  readonly service: string;
  readonly serviceFamily: string;
  readonly cost: Dollars;
  readonly closestOwner: EntityRef | null;
  readonly bucket: MissingTagBucket;
  /** Fraction of this resource's category (service, service_family) that IS
   *  tagged, by cost. 0 for likely-untaggable, >0 for actionable. */
  readonly categoryTaggedRatio: number;
}

/** A single service/family slice of cost that is not attributable to a
 *  resource — tax, support, credits, savings-plan fees, and usage lines with
 *  no resource_id (e.g. inter-AZ data transfer). Reconciles the missing-tag
 *  totals against the overall cost. */
export interface NonResourceCostRow {
  readonly service: string;
  readonly serviceFamily: string;
  readonly lineItemType: string;
  readonly cost: Dollars;
}

export interface MissingTagsResult {
  readonly rows: readonly MissingTagRow[];
  /** Cost of actionable untagged resources — the total to chase. */
  readonly totalActionableCost: Dollars;
  /** Cost of resources in categories where nothing is ever tagged. */
  readonly totalLikelyUntaggableCost: Dollars;
  /** Cost of line items that are not resource-bound (tax, support, etc.). */
  readonly totalNonResourceCost: Dollars;
  readonly actionableCount: number;
  readonly likelyUntaggableCount: number;
  readonly nonResourceRows: readonly NonResourceCostRow[];
}

export interface EntityDetailParams {
  readonly entity: EntityRef;
  readonly dimension: DimensionId;
  readonly dateRange: DateRange;
  readonly filters: FilterMap;
  readonly granularity?: Granularity | undefined;
}

export interface DailyCost {
  readonly date: DateString;
  readonly cost: Dollars;
  readonly breakdown: Readonly<Record<string, Dollars>>;
  readonly breakdownByAccount: Readonly<Record<string, Dollars>>;
}

export interface DistributionSlice {
  readonly name: string;
  readonly cost: Dollars;
  readonly percentage: number;
}

export interface EntityDetailResult {
  readonly entity: EntityRef;
  readonly totalCost: Dollars;
  readonly previousCost: Dollars;
  readonly percentChange: number;
  readonly dailyCosts: readonly DailyCost[];
  readonly byAccount: readonly DistributionSlice[];
  readonly byService: readonly DistributionSlice[];
  readonly bySubEntity: readonly DistributionSlice[];
}

export interface DailyCostsParams {
  readonly dateRange: DateRange;
  readonly filters: FilterMap;
  readonly groupBy: DimensionId;
  readonly granularity?: Granularity | undefined;
}

export interface DailyCostDay {
  readonly date: DateString;
  readonly total: Dollars;
  readonly breakdown: Readonly<Record<string, Dollars>>;
}

export interface DailyCostsResult {
  readonly days: readonly DailyCostDay[];
  readonly groups: readonly string[];
  readonly totalCost: Dollars;
}

export type ImplementationEffort = 'VeryLow' | 'Low' | 'Medium' | 'High';

export interface SavingsRecommendation {
  readonly accountId: string;
  readonly accountName: string;
  readonly actionType: string;
  readonly resourceType: string;
  readonly summary: string;
  readonly region: string;
  readonly monthlySavings: Dollars;
  readonly monthlyCost: Dollars;
  readonly savingsPercentage: number;
  readonly effort: ImplementationEffort;
  readonly resourceArn: string;
  readonly currentDetails: string;
  readonly recommendedDetails: string;
  readonly currentSummary: string;
  readonly restartNeeded: boolean;
  readonly rollbackPossible: boolean;
  readonly recommendationSource: string;
}

export interface SavingsResult {
  readonly recommendations: readonly SavingsRecommendation[];
  readonly totalMonthlySavings: Dollars;
}

export type SyncPhase = 'downloading' | 'repartitioning';

export type SyncStatus =
  | { readonly status: 'idle'; readonly lastSync: Date | null }
  | { readonly status: 'syncing'; readonly phase: SyncPhase; readonly progress: number; readonly filesTotal: number; readonly filesDone: number; readonly message: string }
  | { readonly status: 'completed'; readonly lastSync: Date; readonly filesDownloaded: number }
  | { readonly status: 'failed'; readonly error: Error; readonly lastSync: Date | null };

export type QueryState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly error: Error };
