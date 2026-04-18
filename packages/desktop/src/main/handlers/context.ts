import type { DuckDBInstance, DuckDBConnection } from '../duckdb-loader.js';
import {
  loadConfig,
  loadDimensions,
  loadOrgTree,
  logger,
} from '@costgoblin/core';
import type {
  CostGoblinConfig,
  DimensionsConfig,
  OrgNode,
  SyncStatus,
} from '@costgoblin/core';

export interface IpcContext {
  readonly db: DuckDBInstance;
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
  readonly getConfig: () => Promise<CostGoblinConfig>;
  readonly getDimensions: () => Promise<DimensionsConfig>;
  readonly getOrgTreeConfig: () => Promise<OrgTreeConfig>;
  readonly getAccountMap: () => Promise<Map<string, string>>;
  readonly getOrgAccountsPath: () => Promise<string | undefined>;
  readonly withConnection: <T>(fn: (conn: DuckDBConnection) => Promise<T>) => Promise<T>;
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
    state.dimensions = dimensions;
    return dimensions;
  }

  async function getOrgTreeConfig(): Promise<OrgTreeConfig> {
    if (state.orgTree !== null) return state.orgTree;
    const orgTree = await loadOrgTree(ctx.orgTreePath);
    state.orgTree = orgTree;
    return orgTree;
  }

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
        const data = JSON.parse(raw) as { accounts: { id: string; tags: Record<string, string> }[] };
        const tagLookup = data.accounts.map(a => ({ id: a.id, tags: a.tags }));
        await fs.writeFile(flatPath, JSON.stringify(tagLookup));
        return flatPath;
      } catch {
        return undefined;
      }
    }
  }

  async function withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>): Promise<T> {
    const conn = await ctx.db.connect();
    try {
      return await fn(conn);
    } finally {
      conn.disconnectSync();
    }
  }

  return {
    ctx,
    state,
    getConfig,
    getDimensions,
    getOrgTreeConfig,
    getAccountMap,
    getOrgAccountsPath,
    withConnection,
    invalidateConfig: () => { state.config = null; },
    invalidateDimensions: () => { state.dimensions = null; },
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
