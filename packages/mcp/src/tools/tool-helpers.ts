import {
  asDimensionId,
  asDollars,
  asDateString,
  asTagValue,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  listLocalMonths,
  logger,
} from '@costgoblin/core';
import type {
  DateRange,
  DimensionId,
  DimensionsConfig,
  Dollars,
  FilterMap,
  QueryContextOptions,
  TagValue,
} from '@costgoblin/core';
import type { McpContext, RawRow } from '../context.js';

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

export async function resolveAvailablePeriods(
  dataDir: string,
  tier: 'daily' | 'hourly',
  dateRange: { readonly start: string; readonly end: string },
): Promise<{ available: string[]; empty: boolean }> {
  const available = await listLocalMonths(dataDir, tier);
  const required = computePeriodsInRange(dateRange);
  const usePeriods = required.filter(p => available.includes(p));
  if (usePeriods.length === 0) {
    logger.debug('query:plan', { tier, mode: 'empty', requestedMonths: required.length, availableMonths: available.length });
    return { available, empty: true };
  }
  return { available, empty: false };
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
  const availableColumns = await ctx.getAvailableColumns(tier);
  const { available, empty } = await resolveAvailablePeriods(ctx.dataDir, tier, dateRange);

  if (empty) {
    return {
      opts: { dataDir: ctx.dataDir, dimensions, orgAccountsPath: orgPath, availablePeriods: available, accountReverseMap, costScope, availableColumns },
      empty: true,
    };
  }

  const matSource = ctx.materializedBase.getSource(dateRange, tier);
  const opts: QueryContextOptions = {
    dataDir: ctx.dataDir,
    dimensions,
    orgAccountsPath: orgPath,
    availablePeriods: available,
    accountReverseMap,
    costScope,
    availableColumns,
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

export function lookupDimension(dimensionId: string, dimensions: DimensionsConfig): { label: string; found: boolean } {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  if (builtIn !== undefined) return { label: builtIn.label, found: true };
  const tag = dimensions.tags.find(d => {
    const colName = `tag_${d.tagName.replaceAll(/[^a-zA-Z0-9]/g, '_')}`;
    return colName === dimensionId;
  });
  if (tag !== undefined) return { label: tag.label, found: true };
  return { label: dimensionId, found: false };
}

export type { RawRow };
