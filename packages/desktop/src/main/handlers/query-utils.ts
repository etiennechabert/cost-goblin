import {
  asEntityRef,
  asDollars,
  asDateString,
  getDescendantTagValues,
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
  EntityDetailResult,
  DailyCost,
  DistributionSlice,
  OrgNode,
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
    t => t.concept === 'owner' && `tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === groupBy,
  );
}

export function resolveEntityName(entity: string, accountMap: Map<string, string>): string {
  const mapped = accountMap.get(entity);
  return mapped === undefined ? entity : mapped;
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

export function buildMissingTagsResult(rows: RawRow[]): MissingTagsResult {
  let totalUntaggedCost = 0;
  const missingRows: MissingTagRow[] = [];

  for (const row of rows) {
    const cost = toNum(row['cost']);
    totalUntaggedCost += cost;

    const closestOwner = typeof row['closest_owner'] === 'string' && row['closest_owner'].length > 0
      ? asEntityRef(row['closest_owner'])
      : null;

    missingRows.push({
      accountId: toStr(row['account_id']),
      accountName: toStr(row['account_name']),
      resourceId: toStr(row['resource_id']),
      service: toStr(row['service']),
      serviceFamily: toStr(row['service_family']),
      cost: asDollars(cost),
      closestOwner,
    });
  }

  return {
    rows: missingRows,
    totalUntaggedCost: asDollars(totalUntaggedCost),
    resourceCount: missingRows.length,
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

export function applyOrgTreeRollup(result: CostResult, tree: readonly OrgNode[]): CostResult {
  const entityCostMap = new Map<string, CostRow>();
  for (const row of result.rows) {
    entityCostMap.set(row.entity, row);
  }

  const rolledUpRows: CostRow[] = [];
  const consumedEntities = new Set<string>();

  for (const node of tree) {
    if (node.virtual) {
      const descendants = getDescendantTagValues(node);
      let totalCost = 0;
      const mergedServices: Record<string, number> = {};

      for (const desc of descendants) {
        consumedEntities.add(desc);
        const row = entityCostMap.get(desc);
        if (row !== undefined) {
          totalCost += row.totalCost;
          for (const [svc, cost] of Object.entries(row.serviceCosts)) {
            mergedServices[svc] = (mergedServices[svc] ?? 0) + cost;
          }
        }
      }

      if (totalCost > 0) {
        rolledUpRows.push({
          entity: asEntityRef(node.name),
          totalCost: asDollars(totalCost),
          serviceCosts: Object.fromEntries(
            Object.entries(mergedServices).map(([k, v]) => [k, asDollars(v)]),
          ),
          isVirtual: true,
        });
      }
    } else {
      const descendants = node.children === undefined ? [] : getDescendantTagValues(node);
      for (const desc of descendants) {
        if (desc !== node.name) consumedEntities.add(desc);
      }

      const row = entityCostMap.get(node.name);
      if (node.children !== undefined && node.children.length > 0) {
        let totalCost = row === undefined ? 0 : row.totalCost;
        const mergedServices: Record<string, number> = row === undefined
          ? {}
          : Object.fromEntries(Object.entries(row.serviceCosts).map(([k, v]) => [k, Number(v)]));

        for (const desc of descendants) {
          if (desc === node.name) continue;
          consumedEntities.add(desc);
          const childRow = entityCostMap.get(desc);
          if (childRow !== undefined) {
            totalCost += childRow.totalCost;
            for (const [svc, cost] of Object.entries(childRow.serviceCosts)) {
              mergedServices[svc] = (mergedServices[svc] ?? 0) + cost;
            }
          }
        }

        if (totalCost > 0) {
          rolledUpRows.push({
            entity: asEntityRef(node.name),
            totalCost: asDollars(totalCost),
            serviceCosts: Object.fromEntries(
              Object.entries(mergedServices).map(([k, v]) => [k, asDollars(v)]),
            ),
            isVirtual: true,
          });
        }
      } else if (row !== undefined) {
        rolledUpRows.push(row);
      }
    }
  }

  for (const row of result.rows) {
    if (!consumedEntities.has(row.entity) && !rolledUpRows.some(r => r.entity === row.entity)) {
      rolledUpRows.push(row);
    }
  }

  return {
    ...result,
    rows: rolledUpRows,
  };
}
