import {
  asDimensionId,
  applyNormalizationRule,
  applyRegionFriendlyNames,
  applyStripPatterns,
  buildMaterializeBaseQuery,
  computePeriodsInRange,
  DEFAULT_LAG_DAYS,
  isStringRecord,
  listLocalMonths,
  loadConfig,
  loadCostScope,
  loadDimensions,
  loadOrgTree,
  logger,
  mergeBuiltInExclusionRules,
} from '@costgoblin/core';
import type {
  BuiltInDimension,
  CostGoblinConfig,
  CostScopeConfig,
  DimensionsConfig,
  OrgNode,
  RegionEnrichment,
} from '@costgoblin/core';
import type { DuckDBPool, RawRow } from './duckdb.js';

const DEFAULT_BUILT_INS: readonly BuiltInDimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name', description: 'AWS account the cost was charged to.', useOrgAccounts: true },
  { name: asDimensionId('region'), label: 'Region', field: 'region', description: 'AWS region where the resource ran.', useRegionNames: true },
  { name: asDimensionId('region_country'), label: 'Country', field: 'region', description: 'ISO country code derived from the region.', enabled: false },
  { name: asDimensionId('region_continent'), label: 'Continent', field: 'region', description: 'AWS geographic bucket derived from the region.', enabled: false },
  { name: asDimensionId('service'), label: 'AWS Service', field: 'service', description: 'AWS service code (EC2, S3, RDS, etc.).' },
  { name: asDimensionId('service_family'), label: 'Service Category', field: 'service_family', description: 'Higher-level product category (Compute, Storage, Database).' },
  { name: asDimensionId('line_item_type'), label: 'Line Item Type', field: 'line_item_type', description: 'Usage vs Tax vs Credit vs Discount.' },
  { name: asDimensionId('usage_type'), label: 'Usage Type', field: 'usage_type', description: 'Fine-grained usage string like USE2-BoxUsage:t3.medium.', enabled: false },
  { name: asDimensionId('operation'), label: 'Operation', field: 'operation', description: 'API operation billed for (RunInstances, GetObject).', enabled: false },
  { name: asDimensionId('resource_id'), label: 'Resource', field: 'resource_id', description: 'AWS resource ID or ARN. High-cardinality.' },
];

function mergeDefaultBuiltIns(loaded: DimensionsConfig): DimensionsConfig {
  const defaultsByName = new Map(DEFAULT_BUILT_INS.map(d => [d.name, d]));
  const backfilled = loaded.builtIn.map(d => {
    let next = d;
    if (next.description === undefined) {
      const def = defaultsByName.get(next.name);
      if (def?.description !== undefined) next = { ...next, description: def.description };
    }
    if (next.name === 'region' && next.useRegionNames === undefined) {
      next = { ...next, useRegionNames: true };
    }
    return next;
  });
  const have = new Set(backfilled.map(d => d.name));
  const missing = DEFAULT_BUILT_INS.filter(d => !have.has(d.name));
  const changed = backfilled.some((d, i) => d !== loaded.builtIn[i]);
  if (missing.length === 0 && !changed) return loaded;
  return {
    builtIn: [...backfilled, ...missing],
    tags: loaded.tags,
    ...(loaded.order === undefined ? {} : { order: loaded.order }),
  };
}

interface MaterializedState {
  readonly start: string;
  readonly end: string;
  readonly tier: string;
  readonly configHash: string;
}

class MaterializedBase {
  private state: MaterializedState | null = null;
  private pending: Promise<void> | null = null;

  async materialize(
    runQuery: (sql: string) => Promise<RawRow[]>,
    sql: string,
    dateRange: { readonly start: string; readonly end: string },
    tier: string,
    cfgHash: string,
  ): Promise<void> {
    if (this.pending !== null) {
      await this.pending;
      if (this.state !== null
        && this.state.start === dateRange.start
        && this.state.end === dateRange.end
        && this.state.tier === tier
        && this.state.configHash === cfgHash) {
        return;
      }
    }

    const start = Date.now();
    this.pending = runQuery(sql)
      .then(() => {
        this.state = { start: dateRange.start, end: dateRange.end, tier, configHash: cfgHash };
        logger.info('materialized-base: ready', { dateRange, tier, durationMs: Date.now() - start });
      })
      .catch((err: unknown) => {
        logger.warn(`materialized-base: failed — ${err instanceof Error ? err.message : String(err)}`);
        this.state = null;
      })
      .finally(() => { this.pending = null; });

    return this.pending;
  }

  getSource(
    dateRange: { readonly start: string; readonly end: string },
    tier: string,
  ): string | undefined {
    if (this.state === null) return undefined;
    if (this.state.tier !== tier) return undefined;
    if (this.state.start > dateRange.start || this.state.end < dateRange.end) return undefined;
    return 'cost_base';
  }
}

function configHash(dimensions: unknown, costScope: unknown): string {
  return JSON.stringify({ d: dimensions, c: costScope });
}

function buildAccountReverseMap(accountMap: Map<string, string>): Map<string, readonly string[]> {
  const reverse = new Map<string, string[]>();
  for (const [id, name] of accountMap) {
    const ids = reverse.get(name);
    if (ids === undefined) reverse.set(name, [id]);
    else ids.push(id);
  }
  return reverse;
}

async function loadOrgAccountsMap(dataDir: string, tagKey?: string): Promise<Map<string, string>> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const map = new Map<string, string>();
  try {
    const raw = await fs.readFile(path.join(path.dirname(dataDir), 'org-accounts.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStringRecord(parsed) || !Array.isArray(parsed['accounts'])) return map;
    for (const acct of parsed['accounts']) {
      if (!isStringRecord(acct)) continue;
      const id = acct['id'];
      if (typeof id !== 'string' || id.length === 0) continue;
      if (tagKey !== undefined && tagKey.length > 0 && isStringRecord(acct['tags'])) {
        const tagVal = acct['tags'][tagKey];
        if (typeof tagVal === 'string' && tagVal.length > 0) {
          map.set(id, tagVal);
          continue;
        }
      }
      const name = acct['name'];
      if (typeof name === 'string' && name.length > 0) map.set(id, name);
    }
  } catch { /* no org sync */ }
  return map;
}

async function loadAccountCsv(
  rawDir: string,
): Promise<Map<string, string>> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const map = new Map<string, string>();
  try {
    const entries = await fs.readdir(rawDir);
    const csvFile = entries.find(e => e.toLowerCase().endsWith('.csv') && e.toLowerCase().includes('account'));
    if (csvFile !== undefined) {
      const content = await fs.readFile(path.join(rawDir, csvFile), 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (line === undefined) continue;
        const cols = line.split(',').map(c => c.replaceAll(/^"|"$/g, '').trim());
        const id = cols[0] ?? '';
        const name = cols[4] ?? '';
        if (id.length > 0 && name.length > 0) map.set(id, name);
      }
    }
  } catch { /* no raw dir */ }
  return map;
}

async function generateFlatOrgTags(baseDir: string, flatPath: string): Promise<string | undefined> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  try {
    const raw = await fs.readFile(path.join(baseDir, 'org-accounts.json'), 'utf-8');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return undefined; }
    if (!isStringRecord(parsed) || !Array.isArray(parsed['accounts'])) return undefined;
    const tagLookup: { id: string; tags: Record<string, string> }[] = [];
    for (const acct of parsed['accounts']) {
      if (!isStringRecord(acct)) continue;
      const id = acct['id'];
      const tags = acct['tags'];
      if (typeof id !== 'string' || !isStringRecord(tags)) continue;
      const stringTags: Record<string, string> = {};
      for (const [k, v] of Object.entries(tags)) {
        if (typeof v === 'string') stringTags[k] = v;
      }
      tagLookup.push({ id, tags: stringTags });
    }
    await fs.writeFile(flatPath, JSON.stringify(tagLookup));
    return flatPath;
  } catch {
    return undefined;
  }
}

function parseRegionEntries(regions: Record<string, unknown>, map: Map<string, RegionEnrichment>): void {
  for (const [code, info] of Object.entries(regions)) {
    if (!isStringRecord(info)) continue;
    const longName = info['longName'];
    if (typeof longName !== 'string' || longName.length === 0) continue;
    const country = typeof info['country'] === 'string' ? info['country'] : '';
    const continent = typeof info['continent'] === 'string' ? info['continent'] : '';
    map.set(code, { longName, country, continent });
  }
}

export interface McpContext {
  readonly dataDir: string;
  readonly configDir: string;
  readonly getConfig: () => Promise<CostGoblinConfig>;
  readonly getDimensions: () => Promise<DimensionsConfig>;
  readonly getQueryDimensions: () => Promise<DimensionsConfig>;
  readonly getOrgTree: () => Promise<readonly OrgNode[]>;
  readonly getCostScope: () => Promise<CostScopeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getAccountReverseMap: () => Promise<Map<string, readonly string[]>>;
  readonly getOrgAccountsPath: () => Promise<string | undefined>;
  readonly getAvailableColumns: (tier: 'daily' | 'hourly') => Promise<ReadonlySet<string>>;
  readonly materializedBase: MaterializedBase;
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  readonly runPreparedQuery: (sql: string, params: readonly unknown[]) => Promise<RawRow[]>;
  readonly warmup: () => Promise<void>;
}

export function createMcpContext(db: DuckDBPool, dataDir: string, configDir: string): McpContext {
  const path = import('node:path');

  let cachedConfig: CostGoblinConfig | null = null;
  let cachedDimensions: DimensionsConfig | null = null;
  let cachedCostScope: CostScopeConfig | null = null;
  let cachedAccountMap: Map<string, string> | null = null;
  let cachedAccountReverseMap: Map<string, readonly string[]> | null = null;
  let cachedOrgTree: readonly OrgNode[] | null = null;
  let cachedRegionMap: Map<string, RegionEnrichment> | null = null;
  let cachedOrgAccountsPath: string | undefined | null = null;
  const columnCache = new Map<string, Promise<ReadonlySet<string>>>();
  const materializedBase = new MaterializedBase();

  async function getConfig(): Promise<CostGoblinConfig> {
    if (cachedConfig !== null) return cachedConfig;
    const p = await path;
    const config = await loadConfig(p.join(configDir, 'costgoblin.yaml'));
    cachedConfig = config;
    return config;
  }

  async function getDimensions(): Promise<DimensionsConfig> {
    if (cachedDimensions !== null) return cachedDimensions;
    const p = await path;
    const dimensions = await loadDimensions(p.join(configDir, 'dimensions.yaml'));
    const merged = mergeDefaultBuiltIns(dimensions);
    cachedDimensions = merged;
    return merged;
  }

  async function getRegionMap(): Promise<Map<string, RegionEnrichment>> {
    if (cachedRegionMap !== null) return cachedRegionMap;
    const fs = await import('node:fs/promises');
    const p = await path;
    const map = new Map<string, RegionEnrichment>();
    try {
      const raw = await fs.readFile(p.join(p.dirname(dataDir), 'region-names.json'), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (isStringRecord(parsed) && isStringRecord(parsed['regions'])) {
        parseRegionEntries(parsed['regions'], map);
      }
    } catch { /* no region sync yet */ }
    cachedRegionMap = map;
    return map;
  }

  async function getQueryDimensions(): Promise<DimensionsConfig> {
    const dims = await getDimensions();
    const regionMap = await getRegionMap();
    return applyRegionFriendlyNames(dims, regionMap);
  }

  async function getOrgTree(): Promise<readonly OrgNode[]> {
    if (cachedOrgTree !== null) return cachedOrgTree;
    const p = await path;
    const orgTreeConfig = await loadOrgTree(p.join(configDir, 'org-tree.yaml'));
    cachedOrgTree = orgTreeConfig.tree;
    return orgTreeConfig.tree;
  }

  async function getCostScope(): Promise<CostScopeConfig> {
    if (cachedCostScope !== null) return cachedCostScope;
    const p = await path;
    const loaded = await loadCostScope(p.join(configDir, 'cost-scope.yaml'));
    const merged = mergeBuiltInExclusionRules(loaded);
    cachedCostScope = merged;
    return merged;
  }

  async function getAccountMap(): Promise<Map<string, string>> {
    if (cachedAccountMap !== null) return cachedAccountMap;
    const p = await path;
    const baseDir = p.dirname(dataDir);
    const dimensions = await getDimensions();
    const accountDim = dimensions.builtIn.find(d => d.field === 'account_id');
    const preferOrg = accountDim?.useOrgAccounts === true;
    const tagKey = accountDim?.accountNameFromTag;

    const fromOrg = () => loadOrgAccountsMap(dataDir, tagKey);
    const fromCsv = () => loadAccountCsv(p.join(baseDir, 'raw'));

    const primary = preferOrg ? await fromOrg() : await fromCsv();
    const fallback = preferOrg ? await fromCsv() : await fromOrg();
    const raw = primary.size > 0 ? primary : fallback;

    const normalize = accountDim?.normalize;
    const patterns = accountDim?.nameStripPatterns;
    let map = raw;
    if (normalize !== undefined || (patterns !== undefined && patterns.length > 0)) {
      map = new Map([...raw].map(([id, name]) => {
        let v = name;
        if (normalize !== undefined) v = applyNormalizationRule(v, normalize);
        if (patterns !== undefined && patterns.length > 0) v = applyStripPatterns(v, patterns);
        return [id, v];
      }));
    }

    if (map.size > 0) {
      logger.info(`Loaded account mapping: ${String(map.size)} accounts`);
    }
    cachedAccountMap = map;
    return map;
  }

  async function getAccountReverseMap(): Promise<Map<string, readonly string[]>> {
    if (cachedAccountReverseMap !== null) return cachedAccountReverseMap;
    const accountMap = await getAccountMap();
    const reverseMap = buildAccountReverseMap(accountMap);
    cachedAccountReverseMap = reverseMap;
    return reverseMap;
  }

  async function getOrgAccountsPath(): Promise<string | undefined> {
    if (cachedOrgAccountsPath !== null) return cachedOrgAccountsPath;
    const fs = await import('node:fs/promises');
    const p = await path;
    const baseDir = p.dirname(dataDir);
    const flatPath = p.join(baseDir, 'org-account-tags.json');
    let result: string | undefined;
    try {
      await fs.access(flatPath);
      result = flatPath;
    } catch {
      result = await generateFlatOrgTags(baseDir, flatPath);
    }
    cachedOrgAccountsPath = result;
    return result;
  }

  async function getAvailableColumns(tier: 'daily' | 'hourly'): Promise<ReadonlySet<string>> {
    const cached = columnCache.get(tier);
    if (cached !== undefined) return cached;
    const fetch = (async (): Promise<ReadonlySet<string>> => {
      try {
        const months = await listLocalMonths(dataDir, tier);
        if (months.length === 0) return new Set<string>();
        const month = months.at(-1);
        const glob = `${dataDir}/aws/raw/${tier}-${String(month)}/*.parquet`;
        const rows = await db.runQuery(`DESCRIBE SELECT * FROM read_parquet('${glob}') LIMIT 0`);
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
    columnCache.set(tier, fetch);
    return fetch;
  }

  async function warmup(): Promise<void> {
    try {
      const config = await getConfig();
      const dimensions = await getQueryDimensions();
      const costScope = await getCostScope().catch(() => undefined);
      const accountReverseMap = await getAccountReverseMap();
      const orgPath = await getOrgAccountsPath();
      const availableColumns = await getAvailableColumns('daily');
      const lagDays = costScope?.lagDays ?? DEFAULT_LAG_DAYS;
      const dayMs = 86_400_000;
      const end = new Date(Date.now() - lagDays * dayMs);
      const retentionDays = config.providers[0]?.sync.daily.retentionDays ?? 30;
      const windowDays = Math.min(retentionDays, 30);
      const start = new Date(Date.now() - (windowDays + lagDays) * dayMs);
      const dateRange = {
        start: start.toISOString().slice(0, 10),
        end: end.toISOString().slice(0, 10),
      };
      const available = await listLocalMonths(dataDir, 'daily');
      const required = computePeriodsInRange(dateRange);
      const periods = required.filter(p => available.includes(p));
      if (periods.length === 0) return;

      const hash = configHash(dimensions, costScope);
      const sql = buildMaterializeBaseQuery('daily', dateRange, {
        dataDir, dimensions, orgAccountsPath: orgPath,
        availablePeriods: periods, accountReverseMap, costScope, availableColumns,
      });
      await materializedBase.materialize(
        (s) => db.runQuery(s),
        sql, dateRange, 'daily', hash,
      );
    } catch (err: unknown) {
      logger.warn(`warmup-base: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    dataDir,
    configDir,
    getConfig,
    getDimensions,
    getQueryDimensions,
    getOrgTree,
    getCostScope,
    getAccountMap,
    getAccountReverseMap,
    getOrgAccountsPath,
    getAvailableColumns,
    materializedBase,
    runQuery: (sql) => db.runQuery(sql),
    runPreparedQuery: (sql, params) => db.runPreparedQuery(sql, params),
    warmup,
  };
}
