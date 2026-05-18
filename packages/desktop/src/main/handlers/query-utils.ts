import {
  asEntityRef,
  asDollars,
  asDateString,
  computePeriodsInRange,
  listLocalMonths,
  logger,
  tagColumnName,
} from '@costgoblin/core';
import type {
  CostResult,
  CostRow,
  DateRange,
  DimensionsConfig,
  TrendResult,
  TrendRow,
  MissingTagsResult,
  MissingTagRow,
  MissingTagBucket,
  NonResourceCostRow,
  EntityDetailResult,
  DailyCost,
  DistributionSlice,
} from '@costgoblin/core';
import type { RawRow } from '../duckdb-client.js';

export type EffortLevel = 'VeryLow' | 'Low' | 'Medium' | 'High';

const EFFORT_LEVELS = new Set<string>(['VeryLow', 'Low', 'Medium', 'High']);

export function toEffort(v: string): EffortLevel {
  return EFFORT_LEVELS.has(v) ? v as EffortLevel : 'Medium';
}

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
  if (typeof v === 'object' && 'toString' in v) return (v as { toString(): string }).toString();
  return '';
}

export function isOwnerGroupBy(groupBy: string, dimensions: DimensionsConfig): boolean {
  return dimensions.tags.some(
    t => t.concept === 'owner' && tagColumnName(t.tagName) === groupBy,
  );
}

export function resolveEntityName(entity: string, accountMap: Map<string, string>): string {
  const mapped = accountMap.get(entity);
  return mapped ?? entity;
}

/** Reverse view of the id→name account map. When the user's strip/normalize
 *  rules collapse multiple ids to the same display name, the reverse map
 *  groups them so a single filter or rollup can target all underlying ids. */
export function buildAccountReverseMap(accountMap: Map<string, string>): Map<string, readonly string[]> {
  const reverse = new Map<string, string[]>();
  for (const [id, name] of accountMap) {
    const ids = reverse.get(name);
    if (ids === undefined) reverse.set(name, [id]);
    else ids.push(id);
  }
  return reverse;
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

/** Sums two CostRows assumed to share the same entity. Service breakdowns
 *  are merged additively; isVirtual is preserved if either side has it. */
export function mergeCostRowsByEntity(rows: readonly CostRow[]): CostRow[] {
  const map = new Map<string, { totalCost: number; serviceCosts: Record<string, number>; isVirtual: boolean }>();
  for (const r of rows) {
    const key = r.entity as string;
    const existing = map.get(key);
    if (existing === undefined) {
      const serviceCosts: Record<string, number> = {};
      for (const [svc, cost] of Object.entries(r.serviceCosts)) serviceCosts[svc] = cost;
      map.set(key, { totalCost: r.totalCost, serviceCosts, isVirtual: r.isVirtual === true });
    } else {
      existing.totalCost += r.totalCost;
      for (const [svc, cost] of Object.entries(r.serviceCosts)) {
        existing.serviceCosts[svc] = (existing.serviceCosts[svc] ?? 0) + cost;
      }
      if (r.isVirtual === true) existing.isVirtual = true;
    }
  }
  return [...map.entries()].map(([entity, d]) => ({
    entity: asEntityRef(entity),
    totalCost: asDollars(d.totalCost),
    serviceCosts: Object.fromEntries(Object.entries(d.serviceCosts).map(([k, v]) => [k, asDollars(v)])),
    ...(d.isVirtual ? { isVirtual: true as const } : {}),
  })).sort((a, b) => b.totalCost - a.totalCost);
}

/** Sum delta + costs for trend rows sharing the same entity, then recompute
 *  percentChange against the merged previous total (avoids averaging
 *  percentages, which would lie when one merged side is much larger). */
export function mergeTrendRowsByEntity(rows: readonly TrendRow[]): TrendRow[] {
  const map = new Map<string, { currentCost: number; previousCost: number; delta: number }>();
  for (const r of rows) {
    const key = r.entity as string;
    const existing = map.get(key);
    if (existing === undefined) {
      map.set(key, { currentCost: r.currentCost, previousCost: r.previousCost, delta: r.delta });
    } else {
      existing.currentCost += r.currentCost;
      existing.previousCost += r.previousCost;
      existing.delta += r.delta;
    }
  }
  return [...map.entries()].map(([entity, d]) => ({
    entity: asEntityRef(entity),
    currentCost: asDollars(d.currentCost),
    previousCost: asDollars(d.previousCost),
    delta: asDollars(d.delta),
    percentChange: (() => {
      if (d.previousCost === 0) return d.currentCost === 0 ? 0 : 100;
      return (d.delta / d.previousCost) * 100;
    })(),
  })).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
}

export function buildCostResult(rows: RawRow[], dateRange: DateRange): CostResult {
  const entityMap = new Map<string, { totalCost: number; serviceCosts: Record<string, number> }>();
  const serviceTotals = new Map<string, number>();

  for (const row of rows) {
    const entity = toStr(row['entity']);
    const totalCost = toNum(row['total_cost']);
    const service = typeof row['service'] === 'string' ? row['service'] : null;
    const serviceCost = toNum(row['service_cost']);

    if (!entityMap.has(entity)) {
      entityMap.set(entity, { totalCost, serviceCosts: {} });
    }

    if (service !== null && service.length > 0) {
      const entry = entityMap.get(entity);
      if (entry !== undefined) {
        entry.serviceCosts[service] = serviceCost;
      }
      serviceTotals.set(service, (serviceTotals.get(service) ?? 0) + serviceCost);
    }
  }

  const costRows: CostRow[] = [];
  let totalCost = 0;

  for (const [entity, data] of entityMap) {
    costRows.push({
      entity: asEntityRef(entity),
      totalCost: asDollars(data.totalCost),
      serviceCosts: Object.fromEntries(
        Object.entries(data.serviceCosts).map(([k, v]) => [k, asDollars(v)]),
      ),
    });
    totalCost += data.totalCost;
  }

  const topServices = [...serviceTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);

  return {
    rows: costRows,
    totalCost: asDollars(totalCost),
    topServices,
    dateRange,
  };
}

export function buildTrendResult(rows: RawRow[], deltaThreshold: number, percentThreshold: number): TrendResult {
  const increases: TrendRow[] = [];
  const savings: TrendRow[] = [];
  let totalIncrease = 0;
  let totalSavings = 0;

  for (const row of rows) {
    const entity = toStr(row['entity']);
    const currentCost = toNum(row['current_cost']);
    const previousCost = toNum(row['previous_cost']);
    const delta = toNum(row['delta']);
    const percentChange = toNum(row['percent_change']);

    if (Math.abs(delta) < deltaThreshold) continue;
    if (Math.abs(percentChange) < percentThreshold) continue;

    const trendRow: TrendRow = {
      entity: asEntityRef(entity),
      currentCost: asDollars(currentCost),
      previousCost: asDollars(previousCost),
      delta: asDollars(delta),
      percentChange,
    };

    if (delta > 0) {
      increases.push(trendRow);
      totalIncrease += delta;
    } else {
      savings.push(trendRow);
      totalSavings += Math.abs(delta);
    }
  }

  return {
    increases,
    savings,
    totalIncrease: asDollars(totalIncrease),
    totalSavings: asDollars(totalSavings),
  };
}

function toMissingTagBucket(v: unknown): MissingTagBucket {
  return v === 'likely-untaggable' ? 'likely-untaggable' : 'actionable';
}

export function buildMissingTagsResult(
  resourceRows: RawRow[],
  nonResourceRawRows: RawRow[],
  minCost: number,
): MissingTagsResult {
  const allRows: MissingTagRow[] = [];
  let unfilteredActionableCost = 0;
  let unfilteredLikelyUntaggableCost = 0;
  let unfilteredActionableCount = 0;
  let unfilteredLikelyUntaggableCount = 0;

  for (const row of resourceRows) {
    const cost = toNum(row['cost']);
    const bucket = toMissingTagBucket(row['bucket']);
    const closestOwner = typeof row['closest_owner'] === 'string' && row['closest_owner'].length > 0
      ? asEntityRef(row['closest_owner'])
      : null;

    allRows.push({
      accountId: toStr(row['account_id']),
      accountName: toStr(row['account_name']),
      resourceId: toStr(row['resource_id']),
      service: toStr(row['service']),
      serviceFamily: toStr(row['service_family']),
      cost: asDollars(cost),
      closestOwner,
      bucket,
      categoryTaggedRatio: toNum(row['tagged_ratio']),
    });

    if (bucket === 'actionable') {
      unfilteredActionableCost += cost;
      unfilteredActionableCount += 1;
    } else {
      unfilteredLikelyUntaggableCost += cost;
      unfilteredLikelyUntaggableCount += 1;
    }
  }

  const filtered = minCost > 0 ? allRows.filter(r => Number(r.cost) >= minCost) : allRows;
  let totalActionableCost = 0;
  let totalLikelyUntaggableCost = 0;
  let actionableCount = 0;
  let likelyUntaggableCount = 0;
  for (const r of filtered) {
    const cost = Number(r.cost);
    if (r.bucket === 'actionable') {
      totalActionableCost += cost;
      actionableCount += 1;
    } else {
      totalLikelyUntaggableCost += cost;
      likelyUntaggableCount += 1;
    }
  }

  const nonResourceRows: NonResourceCostRow[] = [];
  let totalNonResourceCost = 0;
  for (const row of nonResourceRawRows) {
    const cost = toNum(row['cost']);
    totalNonResourceCost += cost;
    nonResourceRows.push({
      service: toStr(row['service']),
      serviceFamily: toStr(row['service_family']),
      lineItemType: toStr(row['line_item_type']),
      cost: asDollars(cost),
    });
  }

  return {
    rows: filtered.slice(0, 5000),
    totalRows: filtered.length,
    totalActionableCost: asDollars(totalActionableCost),
    totalLikelyUntaggableCost: asDollars(totalLikelyUntaggableCost),
    totalNonResourceCost: asDollars(totalNonResourceCost),
    actionableCount,
    likelyUntaggableCount,
    unfilteredActionableCount,
    unfilteredActionableCost: asDollars(unfilteredActionableCost),
    unfilteredLikelyUntaggableCount,
    unfilteredLikelyUntaggableCost: asDollars(unfilteredLikelyUntaggableCost),
    nonResourceRows,
  };
}

export function buildEntityDetailResult(rows: RawRow[], entity: string): EntityDetailResult {
  const dailyMap = new Map<string, { cost: number; breakdown: Record<string, number>; breakdownByAccount: Record<string, number> }>();
  const accountMap = new Map<string, number>();
  const serviceMap = new Map<string, number>();
  let totalCost = 0;

  for (const row of rows) {
    const date = toStr(row['usage_date']);
    const service = toStr(row['service']);
    const accountId = toStr(row['account_id']);
    const cost = toNum(row['cost']);

    totalCost += cost;

    if (!dailyMap.has(date)) {
      dailyMap.set(date, { cost: 0, breakdown: {}, breakdownByAccount: {} });
    }
    const day = dailyMap.get(date);
    if (day !== undefined) {
      day.cost += cost;
      day.breakdown[service] = (day.breakdown[service] ?? 0) + cost;
      day.breakdownByAccount[accountId] = (day.breakdownByAccount[accountId] ?? 0) + cost;
    }

    accountMap.set(accountId, (accountMap.get(accountId) ?? 0) + cost);
    serviceMap.set(service, (serviceMap.get(service) ?? 0) + cost);
  }

  const dailyCosts: DailyCost[] = [...dailyMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, data]) => ({
      date: asDateString(date),
      cost: asDollars(data.cost),
      breakdown: Object.fromEntries(
        Object.entries(data.breakdown).map(([k, v]) => [k, asDollars(v)]),
      ),
      breakdownByAccount: Object.fromEntries(
        Object.entries(data.breakdownByAccount).map(([k, v]) => [k, asDollars(v)]),
      ),
    }));

  const toSlices = (map: Map<string, number>): DistributionSlice[] =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, cost]) => ({
        name,
        cost: asDollars(cost),
        percentage: totalCost > 0 ? (cost / totalCost) * 100 : 0,
      }));

  return {
    entity: asEntityRef(entity),
    totalCost: asDollars(totalCost),
    previousCost: asDollars(0),
    percentChange: 0,
    dailyCosts,
    byAccount: toSlices(accountMap),
    byService: toSlices(serviceMap),
    bySubEntity: [],
  };
}

