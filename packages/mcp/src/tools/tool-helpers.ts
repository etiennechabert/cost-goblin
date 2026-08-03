import {
  asDimensionId,
  asDollars,
  asDateString,
  asTagValue,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  listLocalMonths,
  logger,
  tagDimColumn,
} from '@costgoblin/core';
import type {
  DateRange,
  DimensionId,
  DimensionsConfig,
  Dollars,
  FilterMap,
  ProviderName,
  ProviderSourceSpec,
  QueryContextOptions,
  TagValue,
} from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';
import { formatResult, type DataCoverage, type ResponseFormat, type StructuredResult } from '../formatters/result.js';

export function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

export function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return '';
}

export function toDateRange(dr: { start: string; end: string }): DateRange {
  return { start: asDateString(dr.start), end: asDateString(dr.end) };
}

export function defaultDateRange(lagDays?: number): DateRange {
  const lag = lagDays ?? DEFAULT_LAG_DAYS;
  const dayMs = 86_400_000;
  const end = new Date(Date.now() - lag * dayMs);
  const start = new Date(end.getTime() - 29 * dayMs);
  return {
    start: asDateString(start.toISOString().slice(0, 10)),
    end: asDateString(end.toISOString().slice(0, 10)),
  };
}

export function toDimensionId(raw: string): DimensionId {
  return asDimensionId(raw);
}

export function toFilterMap(raw: Record<string, readonly string[]> | undefined): FilterMap {
  if (raw === undefined) {
    const empty: Partial<Record<DimensionId, readonly TagValue[]>> = {};
    return empty;
  }
  const result: Partial<Record<DimensionId, readonly TagValue[]>> = {};
  for (const [key, values] of Object.entries(raw)) {
    result[asDimensionId(key)] = values.map(v => asTagValue(v));
  }
  return result;
}

export function toDollars(n: number): Dollars {
  return asDollars(n);
}

/** First configured provider's name, or null while onboarding (no readable
 *  config / empty provider list). Mirrors desktop getFirstProviderName. */
export async function getFirstProviderName(ctx: McpContext): Promise<ProviderName | null> {
  const config = await ctx.getConfig().catch(() => null);
  return config?.providers[0]?.name ?? null;
}

// Latest-month column set per (provider, tier), probed once per process —
// payer accounts can export different CUR column sets, and a branch whose
// cost expression references a column its files lack binder-errors the whole
// union. Mirrors desktop's per-provider probe.
const columnProbeCache = new Map<string, Promise<ReadonlySet<string>>>();

async function probeProviderColumns(ctx: McpContext, provider: ProviderName, tier: 'daily' | 'hourly'): Promise<ReadonlySet<string>> {
  const key = `${String(provider)}:${tier}`;
  const cached = columnProbeCache.get(key);
  if (cached !== undefined) return cached;
  const fetch = (async (): Promise<ReadonlySet<string>> => {
    const months = await listLocalMonths(ctx.dataDir, provider, tier);
    const latest = months.at(-1);
    if (latest === undefined) return new Set<string>();
    try {
      const rows = await ctx.runQuery(`DESCRIBE SELECT * FROM read_parquet('${ctx.dataDir}/${String(provider)}/raw/${tier}-${latest}/*.parquet') LIMIT 0`);
      const cols = new Set<string>();
      for (const r of rows) {
        const name = r['column_name'];
        if (typeof name === 'string') cols.add(name);
      }
      return cols;
    } catch {
      return new Set<string>();
    }
  })();
  columnProbeCache.set(key, fetch);
  return fetch;
}

/** ProviderSourceSpec list for QueryContextOptions: EVERY configured
 *  provider with its own on-disk months and probed columns (mirrors desktop
 *  getQueryProviders), or [] when none is configured. */
export async function getQueryProviders(
  ctx: McpContext,
  tier: 'daily' | 'hourly',
): Promise<readonly ProviderSourceSpec[]> {
  const config = await ctx.getConfig().catch(() => null);
  if (config === null) return [];
  return Promise.all(config.providers.map(async provider => {
    const [availablePeriods, availableColumns] = await Promise.all([
      listLocalMonths(ctx.dataDir, provider.name, tier),
      probeProviderColumns(ctx, provider.name, tier),
    ]);
    return { name: provider.name, availablePeriods, availableColumns };
  }));
}

export async function buildQueryContextOpts(
  ctx: McpContext,
  dateRange: DateRange,
  tier: 'daily' | 'hourly' = 'daily',
): Promise<{ opts: QueryContextOptions; empty: boolean }> {
  const dimensions = await ctx.getQueryDimensions();
  const accountReverseMap = await ctx.getAccountReverseMap();
  const orgPath = await ctx.getOrgAccountsPath();
  const costScope = await ctx.getCostScope().catch(() => undefined);
  const providers = await getQueryProviders(ctx, tier);

  // Empty only when NO provider has a month intersecting the range.
  const required = computePeriodsInRange(dateRange);
  const anyData = providers.some(p => required.some(m => p.availablePeriods?.includes(m) ?? false));

  if (!anyData) {
    logger.debug('query:plan', { tier, mode: 'empty', requestedMonths: required.length, providers: providers.length });
    return {
      opts: { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, providers, accountReverseMap, costScope },
      empty: true,
    };
  }

  const matSource = ctx.materializedBase.getSource(dateRange, tier);
  const opts: QueryContextOptions = {
    dataDir: ctx.dataDir,
    dimensions,
    orgAccountsPath: orgPath,
    providers,
    accountReverseMap,
    costScope,
    materializedSource: matSource,
  };
  return { opts, empty: false };
}

export function resolveEntityName(entity: string, accountMap: Map<string, string>): string {
  return accountMap.get(entity) ?? entity;
}

export function toolError(message: string): { content: [{ type: 'text'; text: string }]; isError: true } {
  return { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true as const };
}

export function toolResult(text: string): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text' as const, text }] };
}

export function structuredToolResult(
  result: StructuredResult,
  format: ResponseFormat,
): { content: [{ type: 'text'; text: string }] } {
  return toolResult(formatResult(result, format));
}

export async function emptyRangeResult(
  ctx: McpContext,
  dateRange: { readonly start: string; readonly end: string },
  format: ResponseFormat,
  title: string,
): Promise<{ content: [{ type: 'text'; text: string }] }> {
  const coverage = await computeDataCoverage(ctx, dateRange);
  const result: StructuredResult = {
    title,
    coverage,
    notes: [`*No data available for the requested range ${dateRange.start} to ${dateRange.end}. See coverage banner above for what is available.*`],
  };
  return structuredToolResult(result, format);
}

export function resolveFormat(raw: string | undefined): ResponseFormat {
  if (raw === 'json' || raw === 'csv' || raw === 'markdown') return raw;
  return 'markdown';
}

function computeMissingMonthsBetween(available: readonly string[]): string[] {
  if (available.length === 0) return [];
  const set = new Set(available);
  const first = available[0];
  const last = available[available.length - 1];
  if (first === undefined || last === undefined) return [];
  const [fy, fm] = first.split('-').map(n => Number(n));
  const [ly, lm] = last.split('-').map(n => Number(n));
  if (fy === undefined || fm === undefined || ly === undefined || lm === undefined) return [];
  const missing: string[] = [];
  let y = fy;
  let m = fm;
  while (y < ly || (y === ly && m <= lm)) {
    const key = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
    if (!set.has(key)) missing.push(key);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return missing;
}

export async function computeDataCoverage(
  ctx: McpContext,
  dateRange?: { readonly start: string; readonly end: string },
): Promise<DataCoverage> {
  const { listLocalMonths, computePeriodsInRange } = await import('@costgoblin/core');
  const provider = await getFirstProviderName(ctx);
  const available = provider === null ? [] : await listLocalMonths(ctx.dataDir, provider, 'daily');
  if (provider === null || available.length === 0) {
    return {
      availableMonths: [],
      latestDay: null,
      lagDays: null,
      earliestDay: null,
      missingPeriods: [],
      missingInRange: dateRange !== undefined ? computePeriodsInRange(dateRange) : [],
      totalDays: null,
    };
  }
  const earliestMonth = available[0];
  const latestMonth = available[available.length - 1];
  let latestDay: string | null = null;
  if (latestMonth !== undefined) {
    const glob = `${ctx.dataDir}/${String(provider)}/raw/daily-${latestMonth}/*.parquet`;
    try {
      const rows = await ctx.runQuery(
        `SELECT MAX(line_item_usage_start_date::DATE)::VARCHAR AS d FROM read_parquet('${glob}')`,
      );
      const v = rows[0]?.['d'];
      if (typeof v === 'string' && v.length >= 10) latestDay = v.slice(0, 10);
    } catch { /* fall through */ }
  }
  const earliestDay = earliestMonth !== undefined ? `${earliestMonth}-01` : null;

  let lagDays: number | null = null;
  if (latestDay !== null) {
    const latestMs = new Date(`${latestDay}T00:00:00Z`).getTime();
    const todayMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
    lagDays = Math.max(0, Math.round((todayMs - latestMs) / 86_400_000));
  }

  let totalDays: number | null = null;
  if (earliestDay !== null && latestDay !== null) {
    const startMs = new Date(`${earliestDay}T00:00:00Z`).getTime();
    const endMs = new Date(`${latestDay}T00:00:00Z`).getTime();
    totalDays = Math.round((endMs - startMs) / 86_400_000) + 1;
  }

  const missingPeriods = computeMissingMonthsBetween(available);
  const requestedPeriods = dateRange !== undefined ? computePeriodsInRange(dateRange) : [];
  const availableSet = new Set(available);
  const missingInRange = requestedPeriods.filter(p => !availableSet.has(p));

  return {
    availableMonths: available,
    latestDay,
    lagDays,
    earliestDay,
    missingPeriods,
    missingInRange,
    totalDays,
  };
}

export function lookupDimension(dimensionId: string, dimensions: DimensionsConfig): { label: string; found: boolean } {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  if (builtIn !== undefined) return { label: builtIn.label, found: true };
  const tag = dimensions.tags.find(d => tagDimColumn(d) === dimensionId);
  if (tag !== undefined) return { label: tag.label, found: true };
  return { label: dimensionId, found: false };
}

export type { RawRow };
