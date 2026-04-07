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

export interface MissingTagRow {
  readonly accountId: string;
  readonly accountName: string;
  readonly resourceId: string;
  readonly service: string;
  readonly serviceFamily: string;
  readonly cost: Dollars;
  readonly closestOwner: EntityRef | null;
}

export interface MissingTagsResult {
  readonly rows: readonly MissingTagRow[];
  readonly totalUntaggedCost: Dollars;
  readonly resourceCount: number;
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

export type SyncPhase = 'downloading' | 'repartitioning';

export type SyncStatus =
  | { readonly status: 'idle'; readonly lastSync: Date | null }
  | { readonly status: 'syncing'; readonly phase: SyncPhase; readonly progress: number; readonly filesTotal: number; readonly filesDone: number }
  | { readonly status: 'completed'; readonly lastSync: Date; readonly filesDownloaded: number }
  | { readonly status: 'failed'; readonly error: Error; readonly lastSync: Date | null };

export type QueryState<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'success'; readonly data: T }
  | { readonly status: 'error'; readonly error: Error };
