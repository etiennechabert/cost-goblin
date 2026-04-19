import type { DuckDBClient, RawRow } from '../duckdb-client.js';
import {
  asDimensionId,
  loadConfig,
  loadDimensions,
  loadOrgTree,
  logger,
  isStringRecord,
} from '@costgoblin/core';
import type {
  BuiltInDimension,
  CostGoblinConfig,
  DimensionsConfig,
  OrgNode,
  SyncStatus,
} from '@costgoblin/core';

const DEFAULT_BUILT_INS: readonly BuiltInDimension[] = [
  { name: asDimensionId('account'), label: 'Account', field: 'account_id', displayField: 'account_name', description: 'AWS account the cost was charged to. Main axis for org/team-level rollups.', useOrgAccounts: true },
  { name: asDimensionId('region'), label: 'Region', field: 'region', description: 'AWS region where the resource ran. Useful for spotting unintended multi-region sprawl.' },
  { name: asDimensionId('service'), label: 'Service', field: 'service', description: 'AWS service code (EC2, S3, RDS, etc.) — the broadest "what cost me this?" view.' },
  { name: asDimensionId('service_family'), label: 'Service Family', field: 'service_family', description: 'Higher-level product category (Compute, Storage, Database). Good for exec summaries.' },
  { name: asDimensionId('line_item_type'), label: 'Line Item Type', field: 'line_item_type', description: 'Usage vs Tax vs Credit vs Discount. Filter this to isolate real usage from billing adjustments.' },
  { name: asDimensionId('usage_type'), label: 'Usage Type', field: 'usage_type', description: 'Fine-grained usage string like USE2-BoxUsage:t3.medium. Use for instance/storage-tier breakdowns.', enabled: false },
  { name: asDimensionId('operation'), label: 'Operation', field: 'operation', description: 'API operation billed for (RunInstances, GetObject). Useful for API-level cost attribution.', enabled: false },
];

function mergeDefaultBuiltIns(loaded: DimensionsConfig): DimensionsConfig {
  const defaultsByName = new Map(DEFAULT_BUILT_INS.map(d => [d.name, d]));
  // Backfill description on existing entries for any default whose config
  // predates the description field. User-set fields (label, aliases, etc.)
  // are kept — we only fill a missing description.
  const backfilled = loaded.builtIn.map(d => {
    if (d.description !== undefined) return d;
    const def = defaultsByName.get(d.name);
    if (def?.description === undefined) return d;
    return { ...d, description: def.description };
  });
  const have = new Set(backfilled.map(d => d.name));
  const missing = DEFAULT_BUILT_INS.filter(d => !have.has(d.name));
  if (missing.length === 0 && backfilled === loaded.builtIn) return loaded;
  return { builtIn: [...backfilled, ...missing], tags: loaded.tags };
}
import { FileActivityLog } from '../file-activity.js';
import { createOptimizeQueue } from '../optimize-queue.js';
import type { OptimizeQueue } from '../optimize-queue.js';
import { readOptimizeEnabled } from '../optimize-enabled.js';

export interface IpcContext {
  readonly db: DuckDBClient;
  readonly configPath: string;
  readonly dimensionsPath: string;
  readonly orgTreePath: string;
  readonly dataDir: string;
}

export interface OrgTreeConfig {
  readonly tree: readonly OrgNode[];
}

export interface AppState {
  config: CostGoblinConfig | null;
  dimensions: DimensionsConfig | null;
  orgTree: OrgTreeConfig | null;
  syncStatuses: Record<string, SyncStatus>;
  accountMap: Map<string, string> | null;
}

export interface AppContext {
  readonly ctx: IpcContext;
  readonly state: AppState;
  readonly activity: FileActivityLog;
  readonly optimizeQueue: OptimizeQueue;
  readonly getConfig: () => Promise<CostGoblinConfig>;
  readonly getDimensions: () => Promise<DimensionsConfig>;
  readonly getOrgTreeConfig: () => Promise<OrgTreeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getOrgAccountsPath: () => Promise<string | undefined>;
  readonly runQuery: (sql: string) => Promise<RawRow[]>;
  readonly invalidateConfig: () => void;
  readonly invalidateDimensions: () => void;
}

export function createAppContext(ctx: IpcContext): AppContext {
  const state: AppState = {
    config: null,
    dimensions: null,
    orgTree: null,
    syncStatuses: {},
    accountMap: null,
  };

  async function getConfig(): Promise<CostGoblinConfig> {
    if (state.config !== null) return state.config;
    const config = await loadConfig(ctx.configPath);
    state.config = config;
    return config;
  }

  async function getDimensions(): Promise<DimensionsConfig> {
    if (state.dimensions !== null) return state.dimensions;
    const dimensions = await loadDimensions(ctx.dimensionsPath);
    // Fill in any missing default built-ins for users whose dimensions.yaml
    // predates them. Existing entries are kept intact — we only add, never
    // modify. The additions are in-memory; the next dimensions:save-config
    // persists them to disk.
    const merged = mergeDefaultBuiltIns(dimensions);
    state.dimensions = merged;
    return merged;
  }

  async function getOrgTreeConfig(): Promise<OrgTreeConfig> {
    if (state.orgTree !== null) return state.orgTree;
    const orgTree = await loadOrgTree(ctx.orgTreePath);
    state.orgTree = orgTree;
    return orgTree;
  }

  async function getAccountMap(): Promise<Map<string, string>> {
    // Returns the Account id→name map the handlers should use for display
    // resolution. Source depends on the Account dim's `useOrgAccounts` flag:
    //   - true  : org-accounts.json (AWS Organizations sync)
    //   - false : the legacy account-mapping CSV under raw/
    // Both are optional — if the preferred source is missing we fall through
    // to the other one before giving up and returning an empty map.
    if (state.accountMap !== null) return state.accountMap;
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const baseDir = path.dirname(ctx.dataDir);

    const dimensions = await getDimensions();
    const accountDim = dimensions.builtIn.find(d => d.field === 'account_id');
    const preferOrg = accountDim?.useOrgAccounts === true;

    async function fromOrg(): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      try {
        const raw = await fs.readFile(path.join(baseDir, 'org-accounts.json'), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (isStringRecord(parsed) && Array.isArray(parsed['accounts'])) {
          for (const acct of parsed['accounts']) {
            if (!isStringRecord(acct)) continue;
            const id = acct['id'];
            const name = acct['name'];
            if (typeof id === 'string' && typeof name === 'string' && id.length > 0 && name.length > 0) {
              map.set(id, name);
            }
          }
        }
      } catch { /* no org sync */ }
      return map;
    }

    async function fromCsv(): Promise<Map<string, string>> {
      const map = new Map<string, string>();
      try {
        const rawDir = path.join(baseDir, 'raw');
        const entries = await fs.readdir(rawDir);
        const csvFile = entries.find(e => e.toLowerCase().endsWith('.csv') && e.toLowerCase().includes('account'));
        if (csvFile !== undefined) {
          const content = await fs.readFile(path.join(rawDir, csvFile), 'utf-8');
          const lines = content.split('\n').filter(l => l.trim().length > 0);
          for (let i = 1; i < lines.length; i++) {
            const line = lines[i];
            if (line === undefined) continue;
            const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
            const id = cols[0] ?? '';
            const name = cols[4] ?? '';
            if (id.length > 0 && name.length > 0) map.set(id, name);
          }
        }
      } catch { /* no raw dir */ }
      return map;
    }

    const primary = preferOrg ? await fromOrg() : await fromCsv();
    const map = primary.size > 0 ? primary : (preferOrg ? await fromCsv() : await fromOrg());
    if (map.size > 0) {
      logger.info(`Loaded account mapping (${preferOrg ? 'org-data' : 'csv'} preferred): ${String(map.size)} accounts`);
    }
    state.accountMap = map;
    return map;
  }

  async function getOrgAccountsPath(): Promise<string | undefined> {
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const baseDir = path.dirname(ctx.dataDir);
    const flatPath = path.join(baseDir, 'org-account-tags.json');
    try {
      await fs.access(flatPath);
      return flatPath;
    } catch {
      // Try to generate from org-accounts.json if it exists
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
  }

  const activity = new FileActivityLog();
  async function prefsPath(): Promise<string> {
    const path = await import('node:path');
    return path.join(path.dirname(ctx.dataDir), 'app-preferences.json');
  }
  const optimizeQueue = createOptimizeQueue({
    client: ctx.db,
    activity,
    getTags: async () => (await getDimensions()).tags,
    getOrgAccountsPath,
    isEnabled: async () => readOptimizeEnabled(await prefsPath()),
  });

  return {
    ctx,
    state,
    activity,
    optimizeQueue,
    getConfig,
    getDimensions,
    getOrgTreeConfig,
    getAccountMap,
    getOrgAccountsPath,
    runQuery: (sql: string) => ctx.db.runQuery(sql),
    invalidateConfig: () => { state.config = null; },
    invalidateDimensions: () => { state.dimensions = null; state.accountMap = null; },
  };
}

export function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  if (name === 'CredentialsProviderError' || name === 'TokenProviderError') return true;
  return err.message.includes('Token is expired') || err.message.includes('SSO session') || err.message.includes('credentials');
}

export function toUserFriendlyError(err: unknown, profile: string): Error {
  if (isCredentialError(err)) {
    return new Error(`AWS credentials expired for profile "${profile}". Run: aws sso login --profile ${profile}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
