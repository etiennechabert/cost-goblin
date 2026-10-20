import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  asDateString,
  asDimensionId,
  asDollars,
  asEntityRef,
  asProviderName,
  expandOrgNodeValues,
} from '@costgoblin/core';
import type { CostResult, CostRow, DimensionsConfig, OrgNode, TrendRow } from '@costgoblin/core';
import {
  applyOrgTreeRollup,
  buildAccountReverseMap,
  buildCostResult,
  buildDailyCostsResult,
  buildEntityDetailResult,
  buildMissingTagsResult,
  buildTrendResult,
  filterOrgTree,
  isAccountGroupBy,
  isOwnerGroupBy,
  mergeCostRowsByEntity,
  mergeTrendRowsByEntity,
  resolveAvailablePeriods,
  resolveEntityName,
  rollupNodeByValue,
  toEffort,
  toNum,
  toStr,
} from '../main/handlers/query-utils.js';

/** The row helpers and result builders the cost/trend/missing-tag/entity
 *  handlers fold DuckDB rows through. Pure functions — no DuckDB here. */

const RANGE = { start: asDateString('2026-01-01'), end: asDateString('2026-01-31') };

function costRow(entity: string, totalCost: number, serviceCosts: Record<string, number> = {}, isVirtual = false): CostRow {
  return {
    entity: asEntityRef(entity),
    totalCost: asDollars(totalCost),
    serviceCosts: Object.fromEntries(Object.entries(serviceCosts).map(([k, v]) => [k, asDollars(v)])),
    ...(isVirtual ? { isVirtual: true } : {}),
  };
}

function trendRow(entity: string, currentCost: number, previousCost: number): TrendRow {
  return {
    entity: asEntityRef(entity),
    currentCost: asDollars(currentCost),
    previousCost: asDollars(previousCost),
    delta: asDollars(currentCost - previousCost),
    percentChange: 0,
  };
}

function costResult(rows: readonly CostRow[]): CostResult {
  return { rows, totalCost: asDollars(rows.reduce((s, r) => s + r.totalCost, 0)), topServices: [], dateRange: RANGE };
}

/** entity → total, the view of a rolled-up result the assertions care about. */
function totalsByEntity(result: CostResult): Record<string, number> {
  return Object.fromEntries(result.rows.map(r => [String(r.entity), Number(r.totalCost)]));
}

function rowFor(result: CostResult, entity: string): CostRow {
  const row = result.rows.find(r => r.entity === entity);
  if (row === undefined) throw new Error(`no row for ${entity}`);
  return row;
}

describe('toEffort', () => {
  it('keeps each known implementation-effort level and maps anything else to Medium', () => {
    expect(['VeryLow', 'Low', 'Medium', 'High'].map(toEffort)).toEqual(['VeryLow', 'Low', 'Medium', 'High']);
    expect(toEffort('Extreme')).toBe('Medium');
    expect(toEffort('')).toBe('Medium');
  });
});

describe('toNum', () => {
  it('passes numbers through, converts DuckDB bigints, and reads anything else as 0', () => {
    expect(toNum(12.5)).toBe(12.5);
    expect(toNum(42n)).toBe(42);
    expect(toNum('12')).toBe(0);
    expect(toNum(null)).toBe(0);
    expect(toNum(undefined)).toBe(0);
  });
});

describe('toStr', () => {
  it('stringifies the scalar cell types and blanks missing ones', () => {
    expect(toStr('abc')).toBe('abc');
    expect(toStr(null)).toBe('');
    expect(toStr(undefined)).toBe('');
    expect(toStr(3)).toBe('3');
    expect(toStr(false)).toBe('false');
  });

  it('formats a JS Date as its calendar day', () => {
    expect(toStr(new Date('2026-04-01T13:45:00Z'))).toBe('2026-04-01');
  });

  it('uses the toString of a DuckDB value object (e.g. a DATE)', () => {
    class DuckDbDate {
      toString(): string { return '2026-04-01'; }
    }
    expect(toStr(new DuckDbDate())).toBe('2026-04-01');
  });

  it('reads values with no string form as blank', () => {
    expect(toStr(Object.create(null))).toBe('');
    expect(toStr(Symbol('s'))).toBe('');
    expect(toStr(() => 'fn')).toBe('');
  });
});

describe('isOwnerGroupBy', () => {
  const dims: DimensionsConfig = {
    builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
    tags: [
      { tagName: 'team', label: 'Team', concept: 'owner' },
      { tagName: 'env', label: 'Environment', concept: 'environment' },
    ],
  };

  it('is true only for the column id of a tag carrying the owner concept', () => {
    expect(isOwnerGroupBy('tag_team', dims)).toBe(true);
    expect(isOwnerGroupBy('tag_env', dims)).toBe(false);
    expect(isOwnerGroupBy('service', dims)).toBe(false);
  });
});

describe('isAccountGroupBy', () => {
  it('is true for the account dimension and its raw column only', () => {
    expect(isAccountGroupBy('account')).toBe(true);
    expect(isAccountGroupBy('account_id')).toBe(true);
    expect(isAccountGroupBy('account_name')).toBe(false);
    expect(isAccountGroupBy('tag_team')).toBe(false);
  });
});

describe('filterOrgTree', () => {
  const dims: DimensionsConfig = {
    builtIn: [{ name: asDimensionId('service'), label: 'Service', field: 'service' }],
    tags: [{ tagName: 'team', label: 'Team', concept: 'owner' }],
  };
  const tree: OrgNode[] = [{ name: 'eng', children: [{ name: 'web' }] }];

  it('reads the tree only when a filter has a value on the owner dimension', async () => {
    const read = vi.fn(() => Promise.resolve({ tree }));
    expect(await filterOrgTree({ service: ['EC2'] }, dims, read)).toBeUndefined();
    expect(await filterOrgTree({ tag_team: [] }, dims, read)).toBeUndefined();
    expect(await filterOrgTree({ tag_team: [''] }, dims, read)).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(await filterOrgTree({ tag_team: ['', 'eng'] }, dims, read)).toBe(tree);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('is undefined for a tree with no nodes, and fails with a tree that does not load', async () => {
    expect(await filterOrgTree({ tag_team: ['eng'] }, dims, () => Promise.resolve({ tree: [] }))).toBeUndefined();
    await expect(filterOrgTree({ tag_team: ['eng'] }, dims, () => Promise.reject(new Error('bad org-tree.yaml')))).rejects.toThrow('bad org-tree.yaml');
  });
});

describe('account name maps', () => {
  const accountMap = new Map([
    ['111111111111', 'payments'],
    ['222222222222', 'payments'],
    ['333333333333', 'search'],
  ]);

  it('resolveEntityName shows the mapped display name, else the raw id', () => {
    expect(resolveEntityName('333333333333', accountMap)).toBe('search');
    expect(resolveEntityName('999999999999', accountMap)).toBe('999999999999');
  });

  it('buildAccountReverseMap groups every id that shares a display name', () => {
    const reverse = buildAccountReverseMap(accountMap);
    expect(reverse.get('payments')).toEqual(['111111111111', '222222222222']);
    expect(reverse.get('search')).toEqual(['333333333333']);
    expect(reverse.size).toBe(2);
  });
});

describe('resolveAvailablePeriods', () => {
  let dataDir = '';
  const provider = asProviderName('aws-main');

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cg-query-utils-'));
    const month = join(dataDir, 'aws-main', 'raw', 'daily-2026-01');
    await mkdir(month, { recursive: true });
    await writeFile(join(month, 'part-0.parquet'), '');
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it('is not empty when a synced month intersects the range', async () => {
    await expect(resolveAvailablePeriods(dataDir, provider, 'daily', { start: '2025-12-15', end: '2026-01-10' }))
      .resolves.toEqual({ available: ['2026-01'], empty: false });
  });

  it('is empty, still listing what is on disk, when no synced month intersects the range', async () => {
    await expect(resolveAvailablePeriods(dataDir, provider, 'daily', { start: '2026-03-01', end: '2026-03-31' }))
      .resolves.toEqual({ available: ['2026-01'], empty: true });
  });

  it('is empty with nothing available for a tier or provider that has never synced', async () => {
    await expect(resolveAvailablePeriods(dataDir, provider, 'hourly', { start: '2026-01-01', end: '2026-01-31' }))
      .resolves.toEqual({ available: [], empty: true });
    await expect(resolveAvailablePeriods(dataDir, asProviderName('gcp-main'), 'daily', { start: '2026-01-01', end: '2026-01-31' }))
      .resolves.toEqual({ available: [], empty: true });
  });
});

describe('mergeCostRowsByEntity', () => {
  it('sums totals and service breakdowns per entity and sorts by total, highest first', () => {
    const merged = mergeCostRowsByEntity([
      costRow('team-a', 10, { EC2: 6, S3: 4 }),
      costRow('team-b', 25, { EC2: 25 }),
      costRow('team-a', 20, { EC2: 5, Lambda: 15 }),
    ]);
    expect(merged).toEqual([
      costRow('team-a', 30, { EC2: 11, S3: 4, Lambda: 15 }),
      costRow('team-b', 25, { EC2: 25 }),
    ]);
  });

  it('keeps the virtual marker when either side of a merge carries it', () => {
    const [first, second] = mergeCostRowsByEntity([
      costRow('platform', 5),
      costRow('platform', 1, {}, true),
      costRow('solo', 3),
    ]);
    expect(first).toEqual(costRow('platform', 6, {}, true));
    expect(second).toEqual(costRow('solo', 3));
    expect(second !== undefined && 'isVirtual' in second).toBe(false);
  });

  it('returns no rows for no input', () => {
    expect(mergeCostRowsByEntity([])).toEqual([]);
  });
});

describe('mergeTrendRowsByEntity', () => {
  it('recomputes percentChange against the merged previous total instead of averaging percentages', () => {
    const [merged] = mergeTrendRowsByEntity([trendRow('team-a', 110, 100), trendRow('team-a', 30, 10)]);
    expect(merged?.currentCost).toBe(140);
    expect(merged?.previousCost).toBe(110);
    expect(merged?.delta).toBe(30);
    expect(merged?.percentChange).toBeCloseTo((30 / 110) * 100, 10);
  });

  it('reads a brand-new spend as +100% and an all-zero entity as 0%', () => {
    const rows = mergeTrendRowsByEntity([trendRow('new', 50, 0), trendRow('idle', 0, 0)]);
    expect(rows.find(r => r.entity === 'new')?.percentChange).toBe(100);
    expect(rows.find(r => r.entity === 'idle')?.percentChange).toBe(0);
  });

  it('orders by absolute delta so the largest saving can outrank a smaller increase', () => {
    const rows = mergeTrendRowsByEntity([trendRow('up', 120, 100), trendRow('down', 20, 100), trendRow('flat', 5, 5)]);
    expect(rows.map(r => r.entity)).toEqual(['down', 'up', 'flat']);
  });
});

describe('buildCostResult', () => {
  it('folds one row per (entity, service) into entity rows, the grand total and the top services', () => {
    const result = buildCostResult([
      { entity: 'team-a', total_cost: 30, service: 'EC2', service_cost: 20 },
      { entity: 'team-a', total_cost: 30, service: 'S3', service_cost: 10 },
      { entity: 'team-b', total_cost: 12n, service: 'EC2', service_cost: 12n },
    ], RANGE);
    expect(result.rows).toEqual([
      costRow('team-a', 30, { EC2: 20, S3: 10 }),
      costRow('team-b', 12, { EC2: 12 }),
    ]);
    expect(result.totalCost).toBe(42);
    expect(result.topServices).toEqual(['EC2', 'S3']);
    expect(result.dateRange).toBe(RANGE);
  });

  it('keeps an entity whose spend has no service attribution, without a breakdown', () => {
    const result = buildCostResult([
      { entity: 'untagged', total_cost: 7, service: null, service_cost: null },
      { entity: 'blank-service', total_cost: 3, service: '', service_cost: 3 },
    ], RANGE);
    expect(result.rows).toEqual([costRow('untagged', 7), costRow('blank-service', 3)]);
    expect(result.totalCost).toBe(10);
    expect(result.topServices).toEqual([]);
  });

  it('lists at most the five largest services across all entities', () => {
    const services = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const rows = services.map((service, i) => ({ entity: 'e', total_cost: 100, service, service_cost: i + 1 }));
    expect(buildCostResult(rows, RANGE).topServices).toEqual(['G', 'F', 'E', 'D', 'C']);
  });
});

describe('buildDailyCostsResult', () => {
  const rows = [
    { date: '2026-01-02', group_name: '111', cost: 4 },
    { date: '2026-01-01', group_name: '111', cost: 10 },
    { date: '2026-01-01', group_name: '222', cost: 5n },
    { date: '2026-01-01', group_name: '333', cost: 1 },
    { date: '2026-01-02', group_name: null, cost: 2 },
  ];
  const asIs = (group: string): string => group;

  it('keeps each group as its own series, with one entry per day in date order', () => {
    const result = buildDailyCostsResult(rows, asIs);
    expect(result.days).toEqual([
      { date: '2026-01-01', total: 16, breakdown: { '111': 10, '222': 5, '333': 1 } },
      { date: '2026-01-02', total: 6, breakdown: { '111': 4, '': 2 } },
    ]);
    expect(result.groups).toEqual(['111', '222', '333', '']);
    expect(result.totalCost).toBe(22);
  });

  it('sums on each day the groups that get one series name, and lists that name once', () => {
    const result = buildDailyCostsResult(rows, group => (group === '111' || group === '222' ? 'payments' : group));
    expect(result.days.map(d => d.breakdown)).toEqual([{ payments: 15, '333': 1 }, { payments: 4, '': 2 }]);
    expect(result.days.map(d => d.total)).toEqual([16, 6]);
    expect(result.groups).toEqual(['payments', '333', '']);
    expect(result.totalCost).toBe(22);
  });

  it('reads a DuckDB DATE as its calendar day', () => {
    const result = buildDailyCostsResult([{ date: new Date('2026-01-03T00:00:00Z'), group_name: 'x', cost: 1 }], asIs);
    expect(result.days.map(d => d.date)).toEqual(['2026-01-03']);
  });

  it('is empty for no rows', () => {
    expect(buildDailyCostsResult([], asIs)).toEqual({ days: [], groups: [], totalCost: 0 });
  });
});

describe('buildTrendResult', () => {
  const rows = [
    { entity: 'grew', current_cost: 300, previous_cost: 100, delta: 200, percent_change: 200 },
    { entity: 'shrank', current_cost: 50, previous_cost: 150, delta: -100, percent_change: -66.7 },
    { entity: 'tiny-delta', current_cost: 101, previous_cost: 100, delta: 1, percent_change: 1 },
    { entity: 'tiny-percent', current_cost: 10_050, previous_cost: 10_000, delta: 50, percent_change: 0.5 },
  ];

  it('splits rows past both thresholds into increases and savings, totalling each side', () => {
    const result = buildTrendResult(rows, 10, 5);
    expect(result.increases.map(r => r.entity)).toEqual(['grew']);
    expect(result.savings.map(r => r.entity)).toEqual(['shrank']);
    expect(result.totalIncrease).toBe(200);
    expect(result.totalSavings).toBe(100);
    expect(result.savings[0]).toEqual({
      entity: asEntityRef('shrank'),
      currentCost: asDollars(50),
      previousCost: asDollars(150),
      delta: asDollars(-100),
      percentChange: -66.7,
    });
  });

  it('keeps every row when both thresholds are zero', () => {
    const result = buildTrendResult(rows, 0, 0);
    expect(result.increases).toHaveLength(3);
    expect(result.savings).toHaveLength(1);
    expect(result.totalIncrease).toBe(251);
  });
});

describe('buildMissingTagsResult', () => {
  const resourceRows = [
    { account_id: '111', account_name: 'payments', resource_id: 'i-1', service: 'EC2', service_category: 'Compute', cost: 500, bucket: 'actionable', closest_owner: 'team-a', tagged_ratio: 0.8 },
    { account_id: '111', account_name: 'payments', resource_id: 'vol-1', service: 'EBS', service_category: 'Storage', cost: 5, bucket: 'actionable', closest_owner: '', tagged_ratio: 0.5 },
    { account_id: '222', account_name: 'search', resource_id: 'nat-1', service: 'VPC', service_category: 'Network', cost: 200n, bucket: 'likely-untaggable', closest_owner: null, tagged_ratio: 0 },
    { account_id: '222', account_name: 'search', resource_id: 'x-1', service: 'Other', service_category: 'Other', cost: 1, bucket: 'unexpected', closest_owner: 'team-b', tagged_ratio: 0.1 },
  ];
  const nonResourceRows = [
    { service: 'Tax', service_category: 'Tax', charge_category: 'Tax', cost: 40 },
    { service: 'Support', service_category: 'Support', charge_category: 'Purchase', cost: 10 },
  ];

  it('shapes each untagged resource, defaulting an unknown bucket to actionable and a blank owner to none', () => {
    const result = buildMissingTagsResult(resourceRows, [], 0);
    expect(result.rows[0]).toEqual({
      accountId: '111',
      accountName: 'payments',
      resourceId: 'i-1',
      service: 'EC2',
      serviceCategory: 'Compute',
      cost: asDollars(500),
      closestOwner: asEntityRef('team-a'),
      bucket: 'actionable',
      categoryTaggedRatio: 0.8,
    });
    expect(result.rows.map(r => r.closestOwner)).toEqual([asEntityRef('team-a'), null, null, asEntityRef('team-b')]);
    expect(result.rows.map(r => r.bucket)).toEqual(['actionable', 'actionable', 'likely-untaggable', 'actionable']);
  });

  it('applies minCost to the listed rows and filtered totals but not to the unfiltered totals', () => {
    const result = buildMissingTagsResult(resourceRows, nonResourceRows, 10);
    expect(result.rows.map(r => r.resourceId)).toEqual(['i-1', 'nat-1']);
    expect(result.totalRows).toBe(2);
    expect(result.actionableCount).toBe(1);
    expect(result.totalActionableCost).toBe(500);
    expect(result.likelyUntaggableCount).toBe(1);
    expect(result.totalLikelyUntaggableCost).toBe(200);
    expect(result.unfilteredActionableCount).toBe(3);
    expect(result.unfilteredActionableCost).toBe(506);
    expect(result.unfilteredLikelyUntaggableCount).toBe(1);
    expect(result.unfilteredLikelyUntaggableCost).toBe(200);
  });

  it('reports the non-resource spend separately', () => {
    const result = buildMissingTagsResult([], nonResourceRows, 0);
    expect(result.totalNonResourceCost).toBe(50);
    expect(result.nonResourceRows).toEqual([
      { service: 'Tax', serviceCategory: 'Tax', chargeCategory: 'Tax', cost: asDollars(40) },
      { service: 'Support', serviceCategory: 'Support', chargeCategory: 'Purchase', cost: asDollars(10) },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.totalRows).toBe(0);
  });

  it('caps the listed rows at 5000 while counting every match', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({ resource_id: `r-${String(i)}`, cost: 1, bucket: 'actionable' }));
    const result = buildMissingTagsResult(many, [], 0);
    expect(result.rows).toHaveLength(5000);
    expect(result.totalRows).toBe(5001);
    expect(result.actionableCount).toBe(5001);
  });
});

describe('buildEntityDetailResult', () => {
  it('builds the per-day series with service and account breakdowns, sorted by date', () => {
    const result = buildEntityDetailResult([
      { usage_date: '2026-01-02', service: 'EC2', account_id: '111', cost: 30 },
      { usage_date: '2026-01-01', service: 'EC2', account_id: '111', cost: 10 },
      { usage_date: '2026-01-01', service: 'S3', account_id: '222', cost: 5 },
      { usage_date: '2026-01-02', service: 'EC2', account_id: '222', cost: 15n },
    ], 'team-a');

    expect(result.entity).toBe('team-a');
    expect(result.totalCost).toBe(60);
    expect(result.previousCost).toBe(0);
    expect(result.bySubEntity).toEqual([]);
    expect(result.dailyCosts).toEqual([
      { date: asDateString('2026-01-01'), cost: asDollars(15), breakdown: { EC2: asDollars(10), S3: asDollars(5) }, breakdownByAccount: { '111': asDollars(10), '222': asDollars(5) } },
      { date: asDateString('2026-01-02'), cost: asDollars(45), breakdown: { EC2: asDollars(45) }, breakdownByAccount: { '111': asDollars(30), '222': asDollars(15) } },
    ]);
    expect(result.byService).toEqual([
      { name: 'EC2', cost: asDollars(55), percentage: (55 / 60) * 100 },
      { name: 'S3', cost: asDollars(5), percentage: (5 / 60) * 100 },
    ]);
    expect(result.byAccount.map(s => s.name)).toEqual(['111', '222']);
  });

  it('reports 0% shares when the entity has no spend', () => {
    const result = buildEntityDetailResult([{ usage_date: '2026-01-01', service: 'EC2', account_id: '111', cost: 0 }], 'idle');
    expect(result.totalCost).toBe(0);
    expect(result.byService).toEqual([{ name: 'EC2', cost: asDollars(0), percentage: 0 }]);
  });

  it('returns an empty detail for no rows', () => {
    const result = buildEntityDetailResult([], 'nobody');
    expect(result.dailyCosts).toEqual([]);
    expect(result.byAccount).toEqual([]);
    expect(result.byService).toEqual([]);
  });
});

describe('applyOrgTreeRollup', () => {
  it('rolls a virtual group up from its descendants and hides the rolled-up members', () => {
    const tree: OrgNode[] = [{ name: 'platform', virtual: true, children: [{ name: 'team-a' }, { name: 'team-b' }] }];
    const result = applyOrgTreeRollup(costResult([
      costRow('team-a', 10, { EC2: 10 }),
      costRow('team-b', 5, { EC2: 2, S3: 3 }),
      costRow('outsider', 7),
    ]), tree);

    expect(totalsByEntity(result)).toEqual({ platform: 15, outsider: 7 });
    expect(rowFor(result, 'platform')).toEqual(costRow('platform', 15, { EC2: 12, S3: 3 }, true));
    expect(result.dateRange).toBe(RANGE);
  });

  it('drops a virtual group none of whose members has spend', () => {
    const tree: OrgNode[] = [{ name: 'empty-group', virtual: true, children: [{ name: 'ghost' }] }];
    const result = applyOrgTreeRollup(costResult([costRow('team-a', 4)]), tree);
    expect(totalsByEntity(result)).toEqual({ 'team-a': 4 });
  });

  it('folds a real parent\'s own spend together with its descendants into one row named after the parent', () => {
    const tree: OrgNode[] = [{ name: 'eng', children: [{ name: 'web', children: [{ name: 'web-api' }] }, { name: 'data' }] }];
    const result = applyOrgTreeRollup(costResult([
      costRow('eng', 100, { Support: 100 }),
      costRow('web', 20, { EC2: 20 }),
      costRow('web-api', 30, { EC2: 10, Lambda: 20 }),
      costRow('elsewhere', 1),
    ]), tree);

    expect(totalsByEntity(result)).toEqual({ eng: 150, elsewhere: 1 });
    expect(rowFor(result, 'eng')).toEqual(costRow('eng', 150, { Support: 100, EC2: 30, Lambda: 20 }, true));
  });

  it('rolls a real parent up from its children even when it has no spend of its own', () => {
    const tree: OrgNode[] = [{ name: 'eng', children: [{ name: 'web' }] }];
    const result = applyOrgTreeRollup(costResult([costRow('web', 9, { EC2: 9 })]), tree);
    expect(result.rows).toEqual([costRow('eng', 9, { EC2: 9 }, true)]);
  });

  it('skips a real parent whose subtree has no spend at all', () => {
    const tree: OrgNode[] = [{ name: 'eng', children: [{ name: 'web' }] }];
    const result = applyOrgTreeRollup(costResult([costRow('ops', 3)]), tree);
    expect(totalsByEntity(result)).toEqual({ ops: 3 });
  });

  it('passes a leaf node\'s own row through once, and leaves out a leaf with no spend', () => {
    const tree: OrgNode[] = [{ name: 'team-a' }, { name: 'team-b', children: [] }, { name: 'team-c' }];
    const result = applyOrgTreeRollup(costResult([costRow('team-a', 8, { EC2: 8 }), costRow('team-b', 2)]), tree);
    expect(result.rows).toEqual([costRow('team-a', 8, { EC2: 8 }), costRow('team-b', 2)]);
  });

  it('counts the members of a virtual group nested under a real parent toward that parent', () => {
    const tree: OrgNode[] = [{ name: 'eng', children: [{ name: 'squads', virtual: true, children: [{ name: 'team-a' }] }] }];
    const result = applyOrgTreeRollup(costResult([costRow('team-a', 6, { EC2: 6 })]), tree);
    expect(result.rows).toEqual([costRow('eng', 6, { EC2: 6 }, true)]);
  });
});

describe('rollupNodeByValue', () => {
  const tree: OrgNode[] = [
    { name: 'platform', virtual: true, children: [{ name: 'team-a' }, { name: 'squads', virtual: true, children: [{ name: 'team-b' }] }] },
    { name: 'eng', children: [{ name: 'web', children: [{ name: 'web-api' }] }] },
    { name: 'ops' },
    { name: 'empty', virtual: true, children: [] },
  ];

  it('maps each value under a top-level node to that node', () => {
    expect(Object.fromEntries(rollupNodeByValue(tree))).toEqual({
      'team-a': 'platform', 'team-b': 'platform', eng: 'eng', web: 'eng', 'web-api': 'eng', ops: 'ops',
    });
  });

  it('maps a value listed under two top-level nodes to the first', () => {
    const twice: OrgNode[] = [...tree, { name: 'again', virtual: true, children: [{ name: 'team-a' }, { name: 'team-c' }] }];
    const nodeByValue = rollupNodeByValue(twice);
    expect(nodeByValue.get('team-a')).toBe('platform');
    expect(nodeByValue.get('team-c')).toBe('again');
  });

  it('renames and sums rows into the same rows, with the same totals, as applyOrgTreeRollup', () => {
    const rows = [costRow('team-a', 10), costRow('team-b', 5), costRow('eng', 100), costRow('web-api', 30), costRow('ops', 3), costRow('outsider', 7)];
    const nodeByValue = rollupNodeByValue(tree);
    const renamed = mergeCostRowsByEntity(rows.map(r => ({ ...r, entity: asEntityRef(nodeByValue.get(r.entity) ?? r.entity) })));
    expect(totalsByEntity(costResult(renamed))).toEqual(totalsByEntity(applyOrgTreeRollup(costResult(rows), tree)));
  });

  it('sums a value spelled like a virtual node into its series, which a filter on that name keeps too', () => {
    const nodeByValue = rollupNodeByValue(tree);
    const result = buildDailyCostsResult([
      { date: '2026-01-01', group_name: 'team-a', cost: 4 },
      { date: '2026-01-01', group_name: 'platform', cost: 3 },
    ], group => nodeByValue.get(group) ?? group);
    expect(result.days.map(d => d.breakdown)).toEqual([{ platform: 7 }]);
    expect(expandOrgNodeValues(tree, ['platform'])).toEqual(['platform', 'team-a', 'team-b']);
  });

  it('keeps the credit of a node whose values net below zero on a day in that day\'s total', () => {
    const nodeByValue = rollupNodeByValue(tree);
    const result = buildDailyCostsResult([
      { date: '2026-01-01', group_name: 'team-a', cost: 4 },
      { date: '2026-01-01', group_name: 'team-b', cost: -9 },
      { date: '2026-01-01', group_name: 'outsider', cost: 7 },
    ], group => nodeByValue.get(group) ?? group);
    expect(result.days).toEqual([{ date: '2026-01-01', total: 2, breakdown: { platform: -5, outsider: 7 } }]);
  });
});
