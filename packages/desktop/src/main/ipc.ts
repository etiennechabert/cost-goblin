import { ipcMain, shell } from 'electron';
import type { DuckDBInstance, DuckDBConnection } from './duckdb-loader.js';
import {
  buildCostQuery,
  buildDailyCostsQuery,
  buildTrendQuery,
  buildMissingTagsQuery,
  buildEntityDetailQuery,
  buildSource,
  loadConfig,
  loadDimensions,
  loadOrgTree,
  logger,
  asEntityRef,
  asDollars,
  asDateString,
  asDimensionId,
  runSync,
  getDataInventory,
  syncSelectedFiles,
  getDescendantTagValues,
  parseS3Path,
} from '@costgoblin/core';
import type {
  DataInventory,
  ManifestFileEntry,
  AccountMappingStatus,
  AccountMappingEntry,
} from '@costgoblin/core';
import type {
  CostGoblinConfig,
  DimensionsConfig,
  OrgNode,
  Dimension,
  CostQueryParams,
  CostResult,
  CostRow,
  TrendQueryParams,
  TrendResult,
  TrendRow,
  MissingTagsParams,
  MissingTagsResult,
  MissingTagRow,
  DailyCostsParams,
  DailyCostsResult,
  DailyCostDay,
  EntityDetailParams,
  EntityDetailResult,
  DailyCost,
  DistributionSlice,
  SavingsResult,
  SyncStatus,
  DateRange,
  Dollars,
} from '@costgoblin/core';

type RawRow = Readonly<Record<string, unknown>>;
type ExpectedDataType = 'daily' | 'hourly' | 'cost-optimization';

function resolveDataType(syncId: string): ExpectedDataType {
  if (syncId === 'hourly') return 'hourly';
  if (syncId === 'cost-optimization') return 'cost-optimization';
  return 'daily';
}

async function queryAll(conn: DuckDBConnection, sql: string): Promise<RawRow[]> {
  const result = await conn.run(sql);
  const cols = result.columnCount;
  const names: string[] = [];
  for (let i = 0; i < cols; i++) names.push(result.columnName(i));

  const rows: RawRow[] = [];
  let chunk = await result.fetchChunk();
  while (chunk !== null && chunk.rowCount > 0) {
    for (let r = 0; r < chunk.rowCount; r++) {
      const row: Record<string, unknown> = {};
      for (let c = 0; c < cols; c++) {
        const name = names[c];
        if (name !== undefined) row[name] = chunk.getColumnVector(c).getItem(r);
      }
      rows.push(row);
    }
    chunk = await result.fetchChunk();
  }
  return rows;
}

function toNum(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return 0;
}

function toStr(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return '';
}

type EffortLevel = 'VeryLow' | 'Low' | 'Medium' | 'High';
const EFFORT_LEVELS = new Set<string>(['VeryLow', 'Low', 'Medium', 'High']);
function toEffort(v: string): EffortLevel {
  return EFFORT_LEVELS.has(v) ? v as EffortLevel : 'Medium';
}

function buildCostResult(rows: RawRow[], dateRange: DateRange): CostResult {
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

function buildTrendResult(rows: RawRow[], deltaThreshold: number, percentThreshold: number): TrendResult {
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

function buildMissingTagsResult(rows: RawRow[]): MissingTagsResult {
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

function buildEntityDetailResult(rows: RawRow[], entity: string): EntityDetailResult {
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

export interface IpcContext {
  readonly db: DuckDBInstance;
  readonly configPath: string;
  readonly dimensionsPath: string;
  readonly orgTreePath: string;
  readonly dataDir: string;
}

interface AppState {
  config: CostGoblinConfig | null;
  dimensions: DimensionsConfig | null;
  orgTree: OrgTreeConfig | null;
  syncStatuses: Record<string, SyncStatus>;
  accountMap: Map<string, string> | null;
}

interface OrgTreeConfig {
  readonly tree: readonly OrgNode[];
}

function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === 'CredentialsProviderError' || name === 'TokenProviderError') return true;
  return err.message.includes('Token is expired') || err.message.includes('SSO session') || err.message.includes('credentials');
}

function toUserFriendlyError(err: unknown, profile: string): Error {
  if (isCredentialError(err)) {
    return new Error(`AWS credentials expired for profile "${profile}". Run: aws sso login --profile ${profile}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

function isOwnerGroupBy(groupBy: string, dimensions: DimensionsConfig): boolean {
  return dimensions.tags.some(
    t => t.concept === 'owner' && `tag_${t.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === groupBy,
  );
}

export function registerIpcHandlers(ctx: IpcContext): void {
  const state: AppState = {
    config: null,
    dimensions: null,
    orgTree: null,
    syncStatuses: {},
    accountMap: null,
  };

  async function getAccountMap(): Promise<Map<string, string>> {
    if (state.accountMap !== null) return state.accountMap;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const rawDir = path.join(path.dirname(ctx.dataDir), 'raw');
    try {
      const entries = await fs.readdir(rawDir);
      const csvFile = entries.find(e => e.toLowerCase().endsWith('.csv') && e.toLowerCase().includes('account'));
      if (csvFile !== undefined) {
        const content = await fs.readFile(path.join(rawDir, csvFile), 'utf-8');
        const lines = content.split('\n').filter(l => l.trim().length > 0);
        const map = new Map<string, string>();
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          if (line === undefined) continue;
          const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
          const accountId = cols[0] ?? '';
          const name = cols[4] ?? '';
          if (accountId.length > 0 && name.length > 0) {
            map.set(accountId, name);
          }
        }
        state.accountMap = map;
        logger.info(`Loaded account mapping: ${String(map.size)} accounts`);
        return map;
      }
    } catch {
      // no mapping file
    }
    state.accountMap = new Map();
    return state.accountMap;
  }

  async function getConfig(): Promise<CostGoblinConfig> {
    if (state.config !== null) return state.config;
    const config = await loadConfig(ctx.configPath);
    state.config = config;
    return config;
  }

  async function getDimensions(): Promise<DimensionsConfig> {
    if (state.dimensions !== null) return state.dimensions;
    const dimensions = await loadDimensions(ctx.dimensionsPath);
    state.dimensions = dimensions;
    return dimensions;
  }

  async function getOrgTreeConfig(): Promise<OrgTreeConfig> {
    if (state.orgTree !== null) return state.orgTree;
    const orgTree = await loadOrgTree(ctx.orgTreePath);
    state.orgTree = orgTree;
    return orgTree;
  }

  async function withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const conn = await ctx.db.connect();
    try {
      return await fn(conn);
    } finally {
      conn.disconnectSync();
    }
  }

  function resolveEntityName(entity: string, accountMap: Map<string, string>): string {
    const mapped = accountMap.get(entity);
    return mapped !== undefined ? mapped : entity;
  }

  function applyOrgTreeRollup(result: CostResult, tree: readonly OrgNode[]): CostResult {
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
        const descendants = node.children !== undefined ? getDescendantTagValues(node) : [];
        for (const desc of descendants) {
          if (desc !== node.name) consumedEntities.add(desc);
        }

        const row = entityCostMap.get(node.name);
        if (node.children !== undefined && node.children.length > 0) {
          let totalCost = row !== undefined ? row.totalCost : 0;
          const mergedServices: Record<string, number> = row !== undefined
            ? Object.fromEntries(Object.entries(row.serviceCosts).map(([k, v]) => [k, Number(v)]))
            : {};

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

  ipcMain.handle('query:costs', async (_event, params: CostQueryParams): Promise<CostResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const sql = buildCostQuery(params, ctx.dataDir, dimensions);
    logger.info('query:costs', { groupBy: params.groupBy });

    return withConnection(async (conn) => {
      const rows = await queryAll(conn, sql);
      let result = buildCostResult(rows, params.dateRange);

      if (params.groupBy === 'account' || params.groupBy === 'account_id') {
        result = {
          ...result,
          rows: result.rows.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) })),
        };
      }

      if (isOwnerGroupBy(params.groupBy, dimensions) && params.orgNodeValues === undefined) {
        const orgTreeConfig = await getOrgTreeConfig();
        if (orgTreeConfig.tree.length > 0) {
          result = applyOrgTreeRollup(result, orgTreeConfig.tree);
        }
      }

      return result;
    });
  });

  ipcMain.handle('query:daily-costs', async (_event, params: DailyCostsParams): Promise<DailyCostsResult> => {
    const dimensions = await getDimensions();
    const sql = buildDailyCostsQuery(params, ctx.dataDir, dimensions);
    logger.info('query:daily-costs', { groupBy: params.groupBy });

    return withConnection(async (conn) => {
      const rows = await queryAll(conn, sql);

      const dayMap = new Map<string, Record<string, number>>();
      const groupSet = new Set<string>();
      let totalCost = 0;

      for (const row of rows) {
        const rawDate = row['date'];
        const rawGroup = row['group_name'];
        let date: string;
        if (rawDate instanceof Date) {
          date = rawDate.toISOString().slice(0, 10);
        } else if (typeof rawDate === 'string') {
          date = rawDate;
        } else {
          date = '';
        }
        const group = typeof rawGroup === 'string' ? rawGroup : '';
        const cost = Number(row['cost'] ?? 0);

        groupSet.add(group);
        totalCost += cost;

        const existing = dayMap.get(date);
        if (existing !== undefined) {
          existing[group] = (existing[group] ?? 0) + cost;
        } else {
          dayMap.set(date, { [group]: cost });
        }
      }

      const days: DailyCostDay[] = [...dayMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, breakdown]) => {
          const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
          const typedBreakdown: Record<string, Dollars> = {};
          for (const [k, v] of Object.entries(breakdown)) {
            typedBreakdown[k] = asDollars(v);
          }
          return { date: asDateString(date), total: asDollars(total), breakdown: typedBreakdown };
        });

      return { days, groups: [...groupSet], totalCost: asDollars(totalCost) };
    });
  });

  ipcMain.handle('query:trends', async (_event, params: TrendQueryParams): Promise<TrendResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const sql = buildTrendQuery(params, ctx.dataDir, dimensions);
    logger.info('query:trends', { groupBy: params.groupBy });

    return withConnection(async (conn) => {
      const rows = await queryAll(conn, sql);
      const result = buildTrendResult(rows, params.deltaThreshold, params.percentThreshold);
      if (params.groupBy === 'account' || params.groupBy === 'account_id') {
        return {
          ...result,
          increases: result.increases.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) })),
          savings: result.savings.map(r => ({ ...r, entity: asEntityRef(resolveEntityName(r.entity, accountMap)) })),
        };
      }
      return result;
    });
  });

  ipcMain.handle('query:missing-tags', async (_event, params: MissingTagsParams): Promise<MissingTagsResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const sql = buildMissingTagsQuery(params, ctx.dataDir, dimensions);
    logger.info('query:missing-tags', { tagDimension: params.tagDimension });

    return withConnection(async (conn) => {
      const rows = await queryAll(conn, sql);
      const result = buildMissingTagsResult(rows);
      return {
        ...result,
        rows: result.rows.map(r => ({
          ...r,
          accountName: resolveEntityName(r.accountId, accountMap) || r.accountName,
        })),
      };
    });
  });

  ipcMain.handle('query:savings', async (): Promise<SavingsResult> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider?.sync.costOptimization === undefined) {
      return { recommendations: [], totalMonthlySavings: asDollars(0) };
    }

    return withConnection(async (conn) => {
      let rows: RawRow[];
      try {
        rows = await queryAll(conn, `
          SELECT
            account_id,
            account_name,
            action_type,
            current_resource_type,
            COALESCE(recommended_resource_summary, '') AS summary,
            COALESCE(region, '') AS region,
            COALESCE(estimated_monthly_savings_after_discount, 0) AS monthly_savings,
            COALESCE(estimated_monthly_cost_after_discount, 0) AS monthly_cost,
            COALESCE(estimated_savings_percentage_after_discount, 0) AS savings_pct,
            COALESCE(implementation_effort, '') AS effort,
            COALESCE(resource_arn, '') AS resource_arn,
            COALESCE(current_resource_details, '') AS current_details,
            COALESCE(recommended_resource_details, '') AS recommended_details,
            COALESCE(current_resource_summary, '') AS current_summary,
            COALESCE(restart_needed, false) AS restart_needed,
            COALESCE(rollback_possible, false) AS rollback_possible,
            COALESCE(recommendation_source, '') AS recommendation_source
          FROM read_parquet('${ctx.dataDir}/aws/raw/cost-opt-*/*.parquet', filename=true)
          QUALIFY ROW_NUMBER() OVER (PARTITION BY recommendation_id ORDER BY filename DESC) = 1
          ORDER BY monthly_savings DESC
        `);
      } catch {
        return { recommendations: [], totalMonthlySavings: asDollars(0) };
      }

      let totalSavings = 0;
      const recommendations = rows.map(r => {
        const savings = toNum(r['monthly_savings']);
        totalSavings += savings;
        return {
          accountId: toStr(r['account_id']),
          accountName: toStr(r['account_name']),
          actionType: toStr(r['action_type']),
          resourceType: toStr(r['current_resource_type']),
          summary: toStr(r['summary']),
          region: toStr(r['region']),
          monthlySavings: asDollars(savings),
          monthlyCost: asDollars(toNum(r['monthly_cost'])),
          savingsPercentage: toNum(r['savings_pct']),
          effort: toEffort(toStr(r['effort'])),
          resourceArn: toStr(r['resource_arn']),
          currentDetails: toStr(r['current_details']),
          recommendedDetails: toStr(r['recommended_details']),
          currentSummary: toStr(r['current_summary']),
          restartNeeded: Boolean(r['restart_needed']),
          rollbackPossible: Boolean(r['rollback_possible']),
          recommendationSource: toStr(r['recommendation_source']),
        };
      });

      return { recommendations, totalMonthlySavings: asDollars(totalSavings) };
    });
  });

  ipcMain.handle('query:entity-detail', async (_event, params: EntityDetailParams): Promise<EntityDetailResult> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();
    const sql = buildEntityDetailQuery(params, ctx.dataDir, dimensions);
    logger.info('query:entity-detail', { entity: params.entity });

    return withConnection(async (conn) => {
      const rows = await queryAll(conn, sql);
      const result = buildEntityDetailResult(rows, params.entity);
      return {
        ...result,
        byAccount: result.byAccount.map(s => ({
          ...s,
          name: resolveEntityName(s.name, accountMap),
        })),
      };
    });
  });

  ipcMain.handle('query:filter-values', async (_event, dimensionId: string, filterEntries: Record<string, string>, dateRange?: { start: string; end: string }): Promise<{ value: string; count: number }[]> => {
    const dimensions = await getDimensions();
    const accountMap = await getAccountMap();

    const builtIn = dimensions.builtIn.find(d => d.name === dimensionId);
    const tag = dimensions.tags.find(d => `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === dimensionId);

    const field = builtIn !== undefined ? builtIn.field : dimensionId;
    let fieldExpr = field;
    if (tag !== undefined) {
      fieldExpr = (await import('@costgoblin/core')).buildAliasSqlCase(field, tag);
    }

    const whereClauses: string[] = [];
    for (const [key, value] of Object.entries(filterEntries)) {
      const fb = dimensions.builtIn.find(d => d.name === key);
      const ft = dimensions.tags.find(d => `tag_${d.tagName.replace(/[^a-zA-Z0-9]/g, '_')}` === key);
      const ff = fb !== undefined ? fb.field : key;
      let ffExpr = ff;
      if (ft !== undefined) {
        ffExpr = (await import('@costgoblin/core')).buildAliasSqlCase(ff, ft);
      }
      whereClauses.push(`${ffExpr} = '${value.replace(/'/g, "''")}'`);
    }

    if (dateRange !== undefined) {
      whereClauses.push(`usage_date BETWEEN '${dateRange.start}' AND '${dateRange.end}'`);
    }

    const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const source = buildSource(ctx.dataDir, 'daily', dimensions);
    const sql = `
      SELECT ${fieldExpr} AS val, SUM(cost) AS total_cost
      FROM ${source}
      ${whereStr}
      GROUP BY val
      HAVING val IS NOT NULL AND val != ''
      ORDER BY total_cost DESC
      LIMIT 100
    `;

    return withConnection(async (conn) => {
      const rows = await queryAll(conn, sql);
      return rows.map(r => {
        const rawVal = toStr(r['val']);
        const isAccountDim = dimensionId === 'account' || dimensionId === 'account_id';
        const label = isAccountDim ? (accountMap.get(rawVal) ?? rawVal) : rawVal;
        return { value: rawVal, label, count: toNum(r['total_cost']) };
      });
    });
  });

  ipcMain.handle('sync:status', (_event, syncId: string = 'default'): SyncStatus => {
    return state.syncStatuses[syncId] ?? { status: 'idle', lastSync: null };
  });

  ipcMain.handle('sync:trigger', async (): Promise<void> => {
    logger.info('sync:trigger called');

    try {
      const config = await getConfig();
      const dimensions = await getDimensions();
      const provider = config.providers[0];

      if (provider === undefined) {
        throw new Error('No provider configured');
      }

      state.syncStatuses['default'] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: 0, filesDone: 0, message: '' };

      const result = await runSync({
        syncConfig: provider.sync,
        profile: provider.credentials.profile,
        dataDir: ctx.dataDir,
        dimensionsConfig: dimensions,
        onProgress: (progress) => {
          state.syncStatuses['default'] = {
            status: 'syncing',
            phase: progress.phase === 'repartitioning' ? 'repartitioning' : 'downloading',
            progress: progress.filesTotal > 0 ? progress.filesDone / progress.filesTotal : 0,
            filesTotal: progress.filesTotal,
            filesDone: progress.filesDone,
            message: progress.message ?? '',
          };
        },
      });

      state.syncStatuses['default'] = {
        status: 'completed',
        lastSync: new Date(),
        filesDownloaded: result.filesDownloaded,
      };
    } catch (err: unknown) {
      const provider = (await getConfig()).providers[0];
      const profile = provider?.credentials.profile ?? 'default';
      const error = isCredentialError(err) ? toUserFriendlyError(err, profile) : err instanceof Error ? err : new Error(String(err));
      logger.error(`Sync failed: ${error.message}`);
      state.syncStatuses['default'] = {
        status: 'failed',
        error,
        lastSync: null,
      };
    }
  });

  ipcMain.handle('config:get', async (): Promise<CostGoblinConfig> => {
    return getConfig();
  });

  ipcMain.handle('config:dimensions', async (): Promise<Dimension[]> => {
    const dimensions = await getDimensions();
    const builtIn: Dimension[] = dimensions.builtIn.map(d => ({
      name: asDimensionId(d.name),
      label: d.label,
      field: d.field,
      ...(d.displayField !== undefined ? { displayField: d.displayField } : {}),
    }));
    const tags: Dimension[] = dimensions.tags.map(d => ({
      tagName: d.tagName,
      label: d.label,
      ...(d.concept !== undefined ? { concept: d.concept } : {}),
      ...(d.normalize !== undefined ? { normalize: d.normalize } : {}),
      ...(d.separator !== undefined ? { separator: d.separator } : {}),
      ...(d.aliases !== undefined ? { aliases: d.aliases } : {}),
    }));
    return [...builtIn, ...tags];
  });

  ipcMain.handle('config:org-tree', async (): Promise<OrgNode[]> => {
    const orgTree = await getOrgTreeConfig();
    return [...orgTree.tree];
  });

  ipcMain.handle('data:inventory', async (_event, tier?: 'daily' | 'hourly' | 'cost-optimization'): Promise<DataInventory> => {
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');
    const t = tier ?? 'daily';
    let bucket: string;
    if (t === 'hourly') {
      bucket = provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
    } else if (t === 'cost-optimization') {
      const costOptBucket = provider.sync.costOptimization?.bucket;
      if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
      bucket = costOptBucket;
    } else {
      bucket = provider.sync.daily.bucket;
    }
    try {
      return await getDataInventory(bucket, provider.credentials.profile, ctx.dataDir, t);
    } catch (err: unknown) {
      throw toUserFriendlyError(err, provider.credentials.profile);
    }
  });

  ipcMain.handle('data:delete-period', async (_event, period: string, tier: 'daily' | 'hourly' | 'cost-optimization' = 'daily'): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const t = tier;
    const tierDir = path.join(ctx.dataDir, 'aws', t);
    try {
      const entries = await fs.readdir(tierDir);
      for (const entry of entries) {
        if (entry.startsWith(`usage_date=${period}`)) {
          await fs.rm(path.join(tierDir, entry), { recursive: true });
          logger.info(`Deleted local partition (${t}): ${entry}`);
        }
      }
    } catch {
      // dir may not exist
    }
  });

  const syncAbortControllers = new Map<string, AbortController>();

  ipcMain.handle('data:sync-periods', async (_event, fileEntries: ManifestFileEntry[], syncId: string = 'default'): Promise<{ filesDownloaded: number; rowsProcessed: number }> => {
    const id = syncId;
    const config = await getConfig();
    const provider = config.providers[0];
    if (provider === undefined) throw new Error('No provider configured');

    let bucketPath: string;
    if (id === 'hourly') {
      bucketPath = provider.sync.hourly?.bucket ?? provider.sync.daily.bucket;
    } else if (id === 'cost-optimization') {
      const costOptBucket = provider.sync.costOptimization?.bucket;
      if (costOptBucket === undefined) throw new Error('Cost optimization not configured');
      bucketPath = costOptBucket;
    } else {
      bucketPath = provider.sync.daily.bucket;
    }

    const controller = new AbortController();
    syncAbortControllers.set(id, controller);
    state.syncStatuses[id] = { status: 'syncing', phase: 'downloading', progress: 0, filesTotal: fileEntries.length, filesDone: 0, message: '' };

    try {
      const result = await syncSelectedFiles({
        bucketPath,
        profile: provider.credentials.profile,
        dataDir: ctx.dataDir,
        expectedDataType: resolveDataType(id),
        files: fileEntries,
        signal: controller.signal,
        onProgress: (progress) => {
          state.syncStatuses[id] = {
            status: 'syncing',
            phase: progress.phase === 'repartitioning' ? 'repartitioning' : 'downloading',
            progress: progress.filesTotal > 0 ? progress.filesDone / progress.filesTotal : 0,
            filesTotal: progress.filesTotal,
            filesDone: progress.filesDone,
            message: progress.message ?? '',
          };
        },
      });

      syncAbortControllers.delete(id);
      state.syncStatuses[id] = { status: 'completed', lastSync: new Date(), filesDownloaded: result.filesDownloaded };
      return result;
    } catch (err: unknown) {
      syncAbortControllers.delete(id);
      const raw = err instanceof Error ? err : new Error(String(err));
      if (raw.message === 'Download cancelled') {
        state.syncStatuses[id] = { status: 'idle', lastSync: null };
        return { filesDownloaded: 0, rowsProcessed: 0 };
      }
      const error = isCredentialError(err) ? toUserFriendlyError(err, provider.credentials.profile) : raw;
      logger.error(`Selective sync '${id}' failed: ${error.message}`);
      state.syncStatuses[id] = { status: 'failed', error, lastSync: null };
      throw error;
    }
  });

  ipcMain.handle('data:cancel-sync', (_event, syncId: string = 'default'): void => {
    const id = syncId;
    const controller = syncAbortControllers.get(id);
    if (controller !== undefined) {
      controller.abort();
      logger.info(`Sync '${id}' cancelled by user`);
    }
  });

  ipcMain.handle('setup:status', async (): Promise<{ configured: boolean }> => {
    const fs = await import('node:fs/promises');
    try {
      await fs.access(ctx.configPath);
      return { configured: true };
    } catch {
      return { configured: false };
    }
  });

  ipcMain.handle('setup:test-connection', async (_event, params: { profile: string; bucket: string }): Promise<{ ok: boolean; error?: string | undefined }> => {
    try {
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const parsed = parseS3Path(params.bucket);
      const client = new S3Client({
        region: 'eu-central-1',
        ...(params.profile !== 'default' ? { profile: params.profile } : {}),
      });

      await client.send(new ListObjectsV2Command({
        Bucket: parsed.bucket,
        Prefix: parsed.prefix,
        MaxKeys: 1,
      }));

      return { ok: true };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle('setup:list-profiles', async (): Promise<string[]> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    const profiles = new Set<string>();
    profiles.add('default');

    for (const filename of ['config', 'credentials']) {
      const filePath = path.join(os.homedir(), '.aws', filename);
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const profileRegex = /\[(?:profile\s+)?([^\]]+)\]/g;
        let match = profileRegex.exec(content);
        while (match !== null) {
          const name = match[1];
          if (name !== undefined) profiles.add(name.trim());
          match = profileRegex.exec(content);
        }
      } catch {
        // file doesn't exist
      }
    }

    return [...profiles].sort((a, b) => a.localeCompare(b));
  });

  ipcMain.handle('setup:list-buckets', async (_event, profile: string): Promise<{ buckets: { name: string; region: string }[]; error?: string | undefined }> => {
    try {
      const { S3Client, ListBucketsCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'us-east-1',
        ...(profile !== 'default' ? { profile } : {}),
      });

      const response = await client.send(new ListBucketsCommand({}));
      const buckets = (response.Buckets ?? [])
        .filter(b => b.Name !== undefined)
        .map(b => ({ name: b.Name ?? '', region: '' }));
      return { buckets };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info('setup:list-buckets failed', { error: message });
      return { buckets: [], error: message };
    }
  });

  ipcMain.handle('setup:browse-s3', async (_event, params: { profile: string; bucket: string; prefix: string }): Promise<{ prefixes: string[]; isCurReport: boolean; detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown'; missingColumns: string[] }> => {
    try {
      const { S3Client, ListObjectsV2Command, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const client = new S3Client({
        region: 'eu-central-1',
        ...(params.profile !== 'default' ? { profile: params.profile } : {}),
      });

      const response = await client.send(new ListObjectsV2Command({
        Bucket: params.bucket,
        Prefix: params.prefix,
        Delimiter: '/',
        MaxKeys: 200,
      }));

      const prefixes = (response.CommonPrefixes ?? [])
        .filter(p => p.Prefix !== undefined)
        .map(p => {
          const full = p.Prefix ?? '';
          const relative = full.slice(params.prefix.length);
          return relative.replace(/\/$/, '');
        })
        .filter(p => p.length > 0);

      const hasData = prefixes.includes('data');
      const hasMetadata = prefixes.includes('metadata');
      const isCurReport = hasData && hasMetadata;

      let detectedType: 'daily' | 'hourly' | 'cost-optimization' | 'unknown' = 'unknown';
      let missingColumns: string[] = [];

      const requiredCurColumns = [
        'line_item_usage_start_date', 'line_item_usage_account_id',
        'line_item_unblended_cost', 'product_servicecode',
        'product_product_family', 'product_region_code', 'resource_tags',
      ];

      if (isCurReport) {
        try {
          // Find first manifest to detect report type
          const metaList = await client.send(new ListObjectsV2Command({
            Bucket: params.bucket,
            Prefix: `${params.prefix}metadata/`,
            MaxKeys: 10,
          }));

          const manifestKey = (metaList.Contents ?? []).find(c => c.Key?.endsWith('.json'))?.Key;
          if (manifestKey !== undefined) {
            const manifestResponse = await client.send(new GetObjectCommand({ Bucket: params.bucket, Key: manifestKey }));
            const body = await manifestResponse.Body?.transformToString();
            if (body !== undefined) {
              const manifest: unknown = JSON.parse(body);
              let columnNames: string[] = [];
              if (typeof manifest === 'object' && manifest !== null && 'columns' in manifest && Array.isArray((manifest as Record<string, unknown>)['columns'])) {
                columnNames = ((manifest as Record<string, unknown>)['columns'] as unknown[])
                  .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
                  .map(c => typeof c['name'] === 'string' ? c['name'] : '')
                  .filter(n => n.length > 0);
              }

              // Cost optimization reports have specific columns
              if (columnNames.includes('recommendation_id') || columnNames.includes('estimated_monthly_savings')) {
                detectedType = 'cost-optimization';
              } else if (columnNames.includes('line_item_usage_start_date')) {
                // CUR report — daily vs hourly validated post-download
                detectedType = 'daily';
                // Check for missing required columns
                missingColumns = requiredCurColumns.filter(c => !columnNames.includes(c));
              }
            }
          }
        } catch {
          // manifest detection failed
        }
      }

      return { prefixes, isCurReport, detectedType, missingColumns };
    } catch {
      return { prefixes: [], isCurReport: false, detectedType: 'unknown', missingColumns: [] };
    }
  });

  ipcMain.handle('setup:write-config', async (_event, wizardConfig: {
    providerName: string;
    profile: string;
    dailyBucket: string;
    retentionDays?: number | undefined;
    hourlyBucket?: string | undefined;
    costOptBucket?: string | undefined;
    tags?: { tagName: string; label: string; concept?: string | undefined }[] | undefined;
  }): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const { stringify } = await import('yaml');

    const configDir = path.dirname(ctx.configPath);
    await fs.mkdir(configDir, { recursive: true });
    const { parse: parseYaml } = await import('yaml');

    // Load existing config if present, then merge
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(ctx.configPath, 'utf-8');
      const parsed: unknown = parseYaml(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // no existing config
    }

    const existingProviders: Record<string, unknown>[] = Array.isArray(existing['providers'])
      ? existing['providers'].filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
      : [];
    const existingProvider = existingProviders[0] ?? {};
    const rawSync = existingProvider['sync'];
    const existingSync: Record<string, unknown> = typeof rawSync === 'object' && rawSync !== null && !Array.isArray(rawSync)
      ? rawSync as Record<string, unknown>
      : {};

    const sync: Record<string, unknown> = { ...existingSync, intervalMinutes: 60 };

    // Only update tiers that have values — preserve existing for others
    if (wizardConfig.dailyBucket.length > 0) {
      sync['daily'] = { bucket: wizardConfig.dailyBucket, retentionDays: wizardConfig.retentionDays ?? 365 };
    }
    if (wizardConfig.hourlyBucket !== undefined && wizardConfig.hourlyBucket.length > 0) {
      sync['hourly'] = { bucket: wizardConfig.hourlyBucket, retentionDays: 30 };
    }
    if (wizardConfig.costOptBucket !== undefined && wizardConfig.costOptBucket.length > 0) {
      sync['costOptimization'] = { bucket: wizardConfig.costOptBucket, retentionDays: 90 };
    }

    const costgoblinYaml = {
      ...existing,
      providers: [{
        name: wizardConfig.providerName,
        type: 'aws',
        credentials: { profile: wizardConfig.profile },
        sync,
      }],
      defaults: typeof existing['defaults'] === 'object' && existing['defaults'] !== null ? existing['defaults'] : { periodDays: 30, costMetric: 'UnblendedCost', lagDays: 2 },
      cache: typeof existing['cache'] === 'object' && existing['cache'] !== null ? existing['cache'] : { ttlMinutes: 15 },
    };

    await fs.writeFile(ctx.configPath, stringify(costgoblinYaml), 'utf-8');

    const builtInDimensions = [
      { name: 'account', label: 'Account', field: 'account_id', displayField: 'account_name' },
      { name: 'region', label: 'Region', field: 'region' },
      { name: 'service', label: 'Service', field: 'service' },
      { name: 'service_family', label: 'Service Family', field: 'service_family' },
    ];

    const tagDimensions = (wizardConfig.tags ?? []).map(t => ({
      tagName: t.tagName,
      label: t.label,
      ...(t.concept !== undefined ? { concept: t.concept } : {}),
    }));

    const dimensionsYaml = {
      builtIn: builtInDimensions,
      tags: tagDimensions,
    };

    await fs.writeFile(ctx.dimensionsPath, stringify(dimensionsYaml), 'utf-8');

    state.config = null;
    state.dimensions = null;
    logger.info('Setup wizard wrote config files');
  });

  ipcMain.handle('data:open-folder', async (): Promise<void> => {
    const fs = await import('node:fs/promises');
    await fs.mkdir(ctx.dataDir, { recursive: true });
    await shell.openPath(ctx.dataDir);
  });

  ipcMain.handle('setup:scaffold-config', async (): Promise<void> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const configDir = path.dirname(ctx.configPath);
    await fs.mkdir(configDir, { recursive: true });

    const configTemplate = `# CostGoblin configuration
# See https://github.com/etiennechabert/cost-goblin for documentation

providers:
  - name: aws-main
    type: aws
    credentials:
      profile: default  # <- your AWS CLI profile name
    sync:
      daily:
        bucket: s3://your-bucket/path/to/cur/  # <- path containing data/ and metadata/
        retentionDays: 365
      intervalMinutes: 60

defaults:
  periodDays: 30
  costMetric: UnblendedCost
  lagDays: 2

cache:
  ttlMinutes: 15
`;

    const dimensionsTemplate = `# Dimension configuration
# Built-in dimensions are always available. Add tag dimensions to map your CUR tags.

builtIn:
  - name: account
    label: Account
    field: account_id
    displayField: account_name
  - name: region
    label: Region
    field: region
  - name: service
    label: Service
    field: service
  - name: service_family
    label: Service Family
    field: service_family

# Map your CUR resource tags below.
# tagName: the tag key in your CUR (without the "user_" prefix)
# concept: owner | product | environment (enables special UI features)
tags: []
  # Example:
  # - tagName: team
  #   label: Team
  #   concept: owner
  # - tagName: app
  #   label: Application
  #   concept: product
  # - tagName: env
  #   label: Environment
  #   concept: environment
`;

    try { await fs.access(ctx.configPath); } catch {
      await fs.writeFile(ctx.configPath, configTemplate, 'utf-8');
    }
    try { await fs.access(ctx.dimensionsPath); } catch {
      await fs.writeFile(ctx.dimensionsPath, dimensionsTemplate, 'utf-8');
    }

    await shell.openPath(configDir);
    logger.info('Scaffolded template config files');
  });

  ipcMain.handle('data:account-mapping', async (): Promise<AccountMappingStatus> => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    const rawDir = path.join(path.dirname(ctx.dataDir), 'raw');
    let csvPath: string | null = null;

    try {
      const entries = await fs.readdir(rawDir);
      const csvFile = entries.find(e => e.toLowerCase().endsWith('.csv') && e.toLowerCase().includes('account'));
      if (csvFile !== undefined) {
        csvPath = path.join(rawDir, csvFile);
      }
    } catch {
      return { status: 'missing' };
    }

    if (csvPath === null) return { status: 'missing' };

    const content = await fs.readFile(csvPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    const headerLine = lines[0];
    if (headerLine === undefined) return { status: 'missing' };

    const accounts: AccountMappingEntry[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (line === undefined) continue;
      const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
      const accountId = cols[0] ?? '';
      const name = cols[4] ?? '';
      const orgPath = cols[2] ?? '';
      const email = cols[3] ?? '';
      const state = cols[5] ?? '';
      if (accountId.length > 0) {
        accounts.push({ accountId, name, orgPath, email, state });
      }
    }

    return { status: 'found', accounts, path: csvPath };
  });
}
