import { ipcMain } from 'electron';
import {
  buildSource,
  buildAliasSqlCase,
  buildRuleMatchExpr,
  computePeriodsInRange,
  expandOrgFiltersPlain,
  findNode,
  getDescendantTagValues,
  getOwnerDimensionId,
  tagColumnName,
  QueryBuilder,
} from '@costgoblin/core';
import type { OrgNode } from '@costgoblin/core';
import type { AppContext } from './context.js';
import {
  toNum,
  toStr,
} from './query-utils.js';
import { originStore } from '../query-log.js';

function resolveFieldExpr(
  dimensionId: string,
  dimensions: import('@costgoblin/core').DimensionsConfig,
): { field: string; fieldExpr: string } {
  const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
  const tag = dimensions.tags.find(d => tagColumnName(d.tagName) === dimensionId);
  const field = builtIn === undefined ? dimensionId : builtIn.field;
  let fieldExpr = field;
  if (builtIn !== undefined) fieldExpr = buildAliasSqlCase(field, builtIn);
  else if (tag !== undefined) fieldExpr = buildAliasSqlCase(field, tag);
  return { field, fieldExpr };
}

/** Build a SQL IN-list using parameterized placeholders. */
function buildSqlList(values: readonly string[], qb: QueryBuilder): string {
  return values.map(v => qb.addParam(v)).join(', ');
}

function resolveAccountIds(
  values: readonly string[],
  accountReverseMap: Map<string, readonly string[]>,
): { allIds: Set<string>; usedReverse: boolean } {
  const allIds = new Set<string>();
  let usedReverse = false;
  for (const v of values) {
    const ids = accountReverseMap.get(v);
    if (ids !== undefined && ids.length > 0) {
      for (const id of ids) allIds.add(id);
      usedReverse = true;
    } else {
      allIds.add(v);
    }
  }
  return { allIds, usedReverse };
}

function buildValueClause(fieldExpr: string, values: readonly string[], qb: QueryBuilder): string {
  if (values.length === 1) {
    const first = values[0];
    if (first === undefined) return '';
    return `${fieldExpr} = ${qb.addParam(first)}`;
  }
  return `${fieldExpr} IN (${buildSqlList(values, qb)})`;
}

function buildFilterWhereClauses(
  filterEntries: Record<string, readonly string[]>,
  dimensions: import('@costgoblin/core').DimensionsConfig,
  accountReverseMap: Map<string, readonly string[]>,
  qb: QueryBuilder,
): string[] {
  const clauses: string[] = [];
  for (const [key, values] of Object.entries(filterEntries)) {
    if (values.length === 0) continue;
    const { field: ff, fieldExpr: ffExpr } = resolveFieldExpr(key, dimensions);

    if (ff === 'account_id') {
      const { allIds, usedReverse } = resolveAccountIds(values, accountReverseMap);
      if (usedReverse) {
        clauses.push(`${ff} IN (${buildSqlList([...allIds], qb)})`);
        continue;
      }
    }
    const clause = buildValueClause(ffExpr, values, qb);
    if (clause.length > 0) clauses.push(clause);
  }
  return clauses;
}

function buildExclusionWhereClauses(
  costScope: import('@costgoblin/core').CostScopeConfig | undefined,
  dimensions: import('@costgoblin/core').DimensionsConfig,
  accountReverseMap: Map<string, readonly string[]>,
  qb: QueryBuilder,
): string[] {
  if (costScope === undefined) return [];
  const clauses: string[] = [];
  for (const rule of costScope.rules) {
    if (!rule.enabled) continue;
    const matchExpr = buildRuleMatchExpr(rule, dimensions, accountReverseMap, qb);
    if (matchExpr !== null) clauses.push(`NOT (${matchExpr})`);
  }
  return clauses;
}

function mergeAccountRows(
  rows: import('../duckdb-client.js').RawRow[],
  accountMap: Map<string, string>,
): { value: string; label: string; count: number; isVirtual?: true | undefined }[] {
  const merged = new Map<string, number>();
  for (const r of rows) {
    const rawVal = toStr(r['val']);
    const name = accountMap.get(rawVal) ?? rawVal;
    merged.set(name, (merged.get(name) ?? 0) + toNum(r['total_cost']));
  }
  return [...merged.entries()]
    .map(([name, cost]) => ({ value: name, label: name, count: cost }))
    .sort((a, b) => b.count - a.count);
}

/** Walk the org tree and emit one synthetic filter entry per virtual node,
 *  summing the costs of its descendant leaves (looked up in `leafCosts`).
 *  Departments with zero total are dropped — no point offering a filter that
 *  would zero the table. */
function synthesizeVirtualEntries(
  tree: readonly OrgNode[],
  leafCosts: Map<string, number>,
): { value: string; label: string; count: number; isVirtual: true }[] {
  const out: { value: string; label: string; count: number; isVirtual: true }[] = [];
  function walk(node: OrgNode): void {
    if (node.children === undefined || node.children.length === 0) return;
    let total = 0;
    for (const leaf of getDescendantTagValues(node)) {
      total += leafCosts.get(leaf) ?? 0;
    }
    if (total > 0) {
      out.push({ value: node.name, label: node.name, count: total, isVirtual: true });
    }
    for (const child of node.children) walk(child);
  }
  for (const node of tree) walk(node);
  return out;
}

export function registerFilterHandlers(app: AppContext): void {
  const { ctx, getQueryDimensions: getDimensions, getAccountMap, getAccountReverseMap, getOrgAccountsPath, getOrgTreeConfig, getCostScope, getAvailableColumns, runPreparedQuery, materializedBase } = app;

  ipcMain.handle('query:filter-values', (_event, dimensionId: string, filterEntries: Record<string, readonly string[]>, dateRange?: { start: string; end: string }, opts?: { bypassCostScope?: boolean }, origin?: string): Promise<{ value: string; label: string; count: number; isVirtual?: true | undefined }[]> => originStore.run(origin ?? null, async () => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const accountReverseMap = await getAccountReverseMap();
    const orgTreeConfig = await getOrgTreeConfig();
    const costScope = opts?.bypassCostScope === true
      ? undefined
      : await getCostScope().catch(() => undefined);

    const ownerDimensionId = getOwnerDimensionId(dimensions);
    const isOwnerDim = ownerDimensionId !== undefined && dimensionId === ownerDimensionId;

    // Filter input may contain virtual department names (the user picked a
    // department chip); expand them to leaves before composing the SQL.
    const expandedFilterEntries = expandOrgFiltersPlain(filterEntries, ownerDimensionId, orgTreeConfig.tree);

    const qb = new QueryBuilder();
    const { fieldExpr } = resolveFieldExpr(dimensionId, dimensions);

    const matSource = dateRange === undefined
      ? undefined
      : materializedBase.getSource(dateRange, 'daily');

    const filterClauses = buildFilterWhereClauses(expandedFilterEntries, dimensions, accountReverseMap, qb);
    const exclusionClauses = matSource === undefined
      ? buildExclusionWhereClauses(costScope, dimensions, accountReverseMap, qb)
      : [];
    const whereClauses = [...filterClauses, ...exclusionClauses];

    if (dateRange !== undefined && matSource === undefined) {
      const startParam = qb.addParam(dateRange.start);
      const endParam = qb.addParam(dateRange.end);
      whereClauses.push(`usage_date BETWEEN ${startParam} AND ${endParam}`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    let source: string;
    if (matSource === undefined) {
      const orgPath = await getOrgAccountsPath();
      const periods = dateRange === undefined ? undefined : computePeriodsInRange(dateRange);
      const availableColumns = await getAvailableColumns('daily');
      source = buildSource({ dataDir: ctx.dataDir, tier: 'daily', dimensions, orgAccountsPath: orgPath, periods, costMetric: 'unblended', availableColumns });
    } else {
      source = matSource;
    }

    // For the owner dim we fetch un-limited values so the synthesized virtual
    // entries can sum from a complete leaf set; cardinality is bounded by
    // team count, not data volume.
    const limitClause = isOwnerDim ? '' : 'LIMIT 100';
    const sql = `
      SELECT ${fieldExpr} AS val, SUM(cost) AS total_cost
      FROM ${source}
      ${whereStr}
      GROUP BY val
      HAVING val IS NOT NULL AND val != ''
      ORDER BY total_cost DESC
      ${limitClause}
    `;

    const params = qb.build().params;
    const rows = await runPreparedQuery(sql, params, matSource !== undefined);
    const isAccountDim = dimensionId === 'account' || dimensionId === 'account_id';
    if (isAccountDim) return mergeAccountRows(rows, accountMap);

    const leafEntries = rows.map(r => {
      const rawVal = toStr(r['val']);
      return { value: rawVal, label: rawVal, count: toNum(r['total_cost']) };
    });

    if (!isOwnerDim) return leafEntries;

    // Synthesize one entry per virtual node, summing its descendant leaves.
    // Hide leaves that already appear as the picked filter value's expansion —
    // when the user has picked "Engineering" we want the chip dropdown to keep
    // showing Engineering, not the expanded leaves.
    const leafCosts = new Map(leafEntries.map(e => [e.value, e.count]));
    const virtualEntries = synthesizeVirtualEntries(orgTreeConfig.tree, leafCosts);

    // If the user has the owner dim filtered to a virtual node, only show the
    // virtual node itself (so they can deselect it) and that node's children
    // (so they can drill in by deselecting siblings).
    const pickedOwner = filterEntries[ownerDimensionId];
    if (pickedOwner !== undefined && pickedOwner.length === 1) {
      const pickedNode = findNode(orgTreeConfig.tree, pickedOwner[0] ?? '');
      if (pickedNode !== undefined && pickedNode.children !== undefined && pickedNode.children.length > 0) {
        const childNames = new Set(pickedNode.children.map(c => c.name));
        const filtered = [
          ...virtualEntries.filter(e => e.value === pickedNode.name || childNames.has(e.value)),
          ...leafEntries.filter(e => childNames.has(e.value)),
        ];
        return filtered.sort((a, b) => b.count - a.count).slice(0, 200);
      }
    }

    const merged = [...virtualEntries, ...leafEntries];
    return merged.sort((a, b) => b.count - a.count).slice(0, 200);
  }));
}
