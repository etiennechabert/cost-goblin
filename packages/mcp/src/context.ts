import type {
  CostGoblinConfig,
  CostScopeConfig,
  DimensionsConfig,
} from '@costgoblin/core';

export type RawRow = Readonly<Record<string, unknown>>;

export interface McpContext {
  readonly dataDir: string;
  /** Root for per-workspace state JSONs (baselines, org lookups). */
  readonly stateDir: string;
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  readonly runPreparedQuery: (sql: string, params: readonly unknown[]) => Promise<RawRow[]>;
  readonly getConfig: () => Promise<CostGoblinConfig>;
  readonly getDimensions: () => Promise<DimensionsConfig>;
  readonly getQueryDimensions: () => Promise<DimensionsConfig>;
  readonly getCostScope: () => Promise<CostScopeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getAccountReverseMap: () => Promise<Map<string, readonly string[]>>;
  readonly getOrgAccountsPath: () => Promise<string | undefined>;
  readonly getAvailableColumns: (tier: 'daily' | 'hourly') => Promise<ReadonlySet<string>>;
  readonly materializedBase: { getSource(dateRange: { readonly start: string; readonly end: string }, tier: string): string | undefined };
  readonly warmup: () => Promise<void>;
}
