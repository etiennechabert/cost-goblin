import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { vi, type Mock } from 'vitest';
import type { Clock } from '@costgoblin/core';
import type { DuckDBClient, RawRow } from '../../main/duckdb-client.js';
import { createAppContext, type AppContext, type IpcContext } from '../../main/handlers/context.js';
import type { SyncClient, SyncOptions, SyncResult } from '../../main/sync-client.js';
import type { WorkspaceEnv } from '../../main/workspace-env.js';
import { fetchRows, fetchRowsPrepared } from './duckdb-rows.js';
import { newIpcScope, type IpcScope } from './electron-fake.js';

/**
 * A real `AppContext` (from `createAppContext`) over a throwaway workspace, for
 * driving the main process's IPC handlers in a node-project test. Pair it with
 * the fakes in `electron-fake.ts`: register a handler module against
 * `harness.app`, then `invoke(channel, ...args)`.
 *
 * - Config: copies of the committed fixture YAMLs (never the originals).
 * - Data: optionally a COPY of the synthetic Parquet tree vitest's globalSetup
 *   generates — handlers and rollup warmups write under dataDir, and the
 *   shared tree is read by other suites.
 * - DuckDB: an in-process `@duckdb/node-api` instance standing in for the
 *   worker-backed client, rows drained exactly as the worker does. Rollup
 *   partition builds are refused unless asked for, so the background warmups
 *   a handler kicks stay cheap; when they are asked for, `dispose` waits for
 *   them before it deletes the workspace.
 * - Sync: a fake `SyncClient` whose calls each test scripts.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_FIXTURES = join(HERE, '..', '..', '..', '..', 'core', 'src', '__fixtures__');
export const FIXTURE_CONFIG_DIR = join(CORE_FIXTURES, 'config');
export const FIXTURE_MULTI_CONFIG_DIR = join(CORE_FIXTURES, 'config-multi');
export const SYNTHETIC_DIR = join(CORE_FIXTURES, 'synthetic');

/** The provider names the committed fixtures and the synthetic tree agree on. */
export const FIXTURE_AWS_PROVIDER = 'aws-main';
export const FIXTURE_GCP_PROVIDER = 'gcp-main';

/** The day after the synthetic fixture window (Jan–Feb 2026), like e2e's. */
export const FIXTURE_NOW_MS = Date.parse('2026-03-01T12:00:00Z');

/** A clock under which the default 2-day freshness lag leaves all of the
 *  synthetic February readable: at FIXTURE_NOW_MS queries stop at Feb 27. */
export const FEBRUARY_READABLE_NOW_MS = Date.parse('2026-03-02T12:00:00Z');

/** The fixture cost-scope.yaml with its freshness lag set to `lagDays`. */
export async function setCostScopeLag(ws: TestWorkspace, lagDays: number): Promise<void> {
  const yaml = await readFile(ws.costScopePath, 'utf-8');
  await writeFile(ws.costScopePath, `${yaml.trimEnd()}\nlagDays: ${String(lagDays)}\n`);
}

export type FixtureConfigSet = 'single' | 'multi' | 'none';

export interface TestWorkspace {
  readonly root: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly stateDir: string;
  readonly tempDir: string;
  readonly configPath: string;
  readonly dimensionsPath: string;
  readonly orgTreePath: string;
  readonly viewsPath: string;
  readonly costScopePath: string;
}

export interface TestWorkspaceOptions {
  readonly config?: FixtureConfigSet;
  readonly data?: 'synthetic' | 'none';
}

export async function createTestWorkspace(options: TestWorkspaceOptions = {}): Promise<TestWorkspace> {
  const root = await mkdtemp(join(tmpdir(), 'cg-ipc-'));
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const stateDir = join(root, 'state');
  const tempDir = join(root, 'tmp');
  for (const dir of [configDir, dataDir, stateDir, tempDir]) await mkdir(dir, { recursive: true });

  const configSet = options.config ?? 'single';
  if (configSet !== 'none') {
    const source = configSet === 'multi' ? FIXTURE_MULTI_CONFIG_DIR : FIXTURE_CONFIG_DIR;
    for (const file of await readdir(source)) {
      if (file.endsWith('.yaml')) await copyFile(join(source, file), join(configDir, file));
    }
  }
  if (options.data === 'synthetic') await cp(SYNTHETIC_DIR, dataDir, { recursive: true });

  return {
    root, configDir, dataDir, stateDir, tempDir,
    configPath: join(configDir, 'costgoblin.yaml'),
    dimensionsPath: join(configDir, 'dimensions.yaml'),
    orgTreePath: join(configDir, 'org-tree.yaml'),
    viewsPath: join(configDir, 'views.yaml'),
    costScopePath: join(configDir, 'cost-scope.yaml'),
  };
}

export interface HarnessDb extends DuckDBClient {
  readonly cancelPendingQueries: Mock<() => void>;
  readonly configure: Mock<(settings: { tempDir?: string; memoryGB?: number; threads?: number }) => void>;
  /** SQL text of every query and build, in submission order. */
  readonly statements: string[];
}

/** An in-process DuckDB behind the `DuckDBClient` interface. Statements run
 *  one at a time (the worker pools connections; one shared connection must
 *  not interleave), and the instance is created on first use. */
export function createHarnessDb(options: { readonly rollupBuilds?: boolean } = {}): HarnessDb {
  let instance: DuckDBInstance | null = null;
  let conn: DuckDBConnection | null = null;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  const statements: string[] = [];

  async function connection(): Promise<{ instance: DuckDBInstance; conn: DuckDBConnection }> {
    if (closed) throw new Error('DuckDB harness is closed');
    instance ??= await DuckDBInstance.create();
    conn ??= await instance.connect();
    return { instance, conn };
  }

  function serial<T>(run: () => Promise<T>): Promise<T> {
    const next = chain.then(run);
    chain = next.then(() => undefined, () => undefined);
    return next;
  }

  return {
    statements,
    runQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      statements.push(sql);
      return serial(async () => {
        const { conn: c } = await connection();
        onStarted?.();
        return fetchRows(c, sql);
      });
    },
    runPreparedQuery(sql: string, params: readonly unknown[], onStarted?: () => void): Promise<RawRow[]> {
      statements.push(sql);
      return serial(async () => {
        const { conn: c } = await connection();
        onStarted?.();
        return fetchRowsPrepared(c, sql, params);
      });
    },
    runBuildQuery(sql: string, onStarted?: () => void): Promise<RawRow[]> {
      statements.push(sql);
      if (options.rollupBuilds !== true) return Promise.reject(new Error('rollup builds are disabled in this harness'));
      return serial(async () => {
        const { instance: db } = await connection();
        const fresh = await db.connect();
        try {
          onStarted?.();
          return await fetchRows(fresh, sql);
        } finally {
          fresh.closeSync();
        }
      });
    },
    cancelPendingQueries: vi.fn<() => void>(),
    configure: vi.fn<(settings: { tempDir?: string; memoryGB?: number; threads?: number }) => void>(),
    async terminate(): Promise<void> {
      await chain;
      closed = true;
      conn?.closeSync();
      instance?.closeSync();
      conn = null;
      instance = null;
    },
  };
}

export interface FakeSyncClient extends SyncClient {
  readonly syncPeriods: Mock<(options: SyncOptions) => Promise<SyncResult>>;
  readonly cancelSync: Mock<(syncKey: string) => void>;
  readonly terminate: Mock<() => Promise<void>>;
}

export function createFakeSyncClient(): FakeSyncClient {
  return {
    syncPeriods: vi.fn<(options: SyncOptions) => Promise<SyncResult>>(
      () => Promise.reject(new Error('syncPeriods was not scripted for this test')),
    ),
    cancelSync: vi.fn<(syncKey: string) => void>(),
    terminate: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  };
}

/** YAML lines for one AWS provider entry of a costgoblin.yaml. */
export function awsProviderYaml(name: string, profile = 'test-profile', dailyBucket = 's3://test-cur-bucket/daily/'): string[] {
  return [
    `  - name: ${name}`,
    '    type: aws',
    `    credentialsProfile: ${profile}`,
    '    sync:',
    '      daily:',
    `        bucket: ${dailyBucket}`,
    '        retentionDays: 365',
    '      intervalMinutes: 60',
  ];
}

/** YAML lines for one GCP provider entry; `extra` lines are appended as-is. */
export function gcpProviderYaml(name: string, dailyBucket = 'gs://test-focus-export/focus/daily/', extra: readonly string[] = []): string[] {
  return [
    `  - name: ${name}`,
    '    type: gcp',
    ...extra,
    '    sync:',
    '      daily:',
    `        bucket: ${dailyBucket}`,
    '        retentionDays: 365',
    '      intervalMinutes: 60',
  ];
}

/** A complete, loadable costgoblin.yaml over the given provider entries. */
export function configYaml(...providers: readonly (readonly string[])[]): string {
  return [
    'providers:',
    ...providers.flat(),
    'defaults:',
    '  periodDays: 30',
    '  costMetric: unblended_cost',
    '  lagDays: 1',
    '',
  ].join('\n');
}

export function pinnedWorkspaceEnv(ws: TestWorkspace): WorkspaceEnv {
  return { mode: 'pinned', dataDir: ws.dataDir, configBase: ws.configDir, stateDir: ws.stateDir, tempDir: ws.tempDir };
}

export interface HarnessOptions extends TestWorkspaceOptions {
  readonly now?: Clock;
  readonly rollupBuilds?: boolean;
  /** Replace parts of the IpcContext built for the workspace (paths, env). */
  readonly overrides?: (ws: TestWorkspace) => Partial<IpcContext>;
}

export interface Harness {
  readonly ws: TestWorkspace;
  readonly ctx: IpcContext;
  readonly app: AppContext;
  readonly db: HarnessDb;
  readonly sync: FakeSyncClient;
  /** This app's channels — register the handler module(s) under test right
   *  after createHarness (before creating another harness), then invoke. */
  readonly ipc: IpcScope;
  /** Let in-flight warmups (and, with real builds, the partition builds they
   *  launch) settle, close DuckDB, delete the workspace. */
  readonly dispose: () => Promise<void>;
}

/** Wait (bounded) until no rollup build is running. A warmup only launches
 *  its partition builds, so `awaitWarmup` returning says nothing about them;
 *  a build still writing partitions and the manifest would race the
 *  workspace's deletion. */
async function drainRollupBuilds(app: AppContext, timeoutMs: number): Promise<void> {
  // Bounded by a count, not by Date: a test may leave the clock pinned.
  const POLL_MS = 20;
  for (let waited = 0; waited < timeoutMs && app.rollupStore.getStatus().state === 'computing'; waited += POLL_MS) {
    await new Promise<void>((resolve) => { setTimeout(resolve, POLL_MS); });
  }
}

/** Fresh workspace + real AppContext + a fresh, current fake-ipcMain scope. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const ipc = newIpcScope();
  const ws = await createTestWorkspace(options);
  const db = createHarnessDb({ rollupBuilds: options.rollupBuilds ?? false });
  const sync = createFakeSyncClient();
  const base: IpcContext = {
    db,
    syncClient: sync,
    configPath: ws.configPath,
    dimensionsPath: ws.dimensionsPath,
    orgTreePath: ws.orgTreePath,
    viewsPath: ws.viewsPath,
    costScopePath: ws.costScopePath,
    dataDir: ws.dataDir,
    stateDir: ws.stateDir,
    workspaceEnv: pinnedWorkspaceEnv(ws),
    duckdbWorkerPath: join(ws.root, 'duckdb-worker.cjs'),
    now: options.now ?? ((): number => FIXTURE_NOW_MS),
  };
  const ctx: IpcContext = { ...base, ...options.overrides?.(ws) };
  const app = createAppContext(ctx);
  return {
    ws, ctx, app, db, sync, ipc,
    dispose: async () => {
      await app.awaitWarmup(5_000).catch(() => false);
      // Builds are refused unless asked for, so only real ones can still be writing.
      if (options.rollupBuilds === true) await drainRollupBuilds(app, 15_000);
      await db.terminate();
      await rm(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// ---- Narrowing an `unknown` IPC result without type assertions ----------

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk `value` by object keys / array indexes, failing the test on a miss. */
export function at(value: unknown, ...path: readonly (string | number)[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof key === 'number') {
      if (!Array.isArray(current)) throw new Error(`expected an array before [${String(key)}]`);
      const items: readonly unknown[] = current;
      current = items[key];
    } else {
      if (!isRecord(current)) throw new Error(`expected an object before .${key}`);
      current = current[key];
    }
  }
  return current;
}

export function str(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`expected a string, got ${typeof value}`);
  return value;
}

export function num(value: unknown): number {
  if (typeof value !== 'number') throw new Error(`expected a number, got ${typeof value}`);
  return value;
}

export function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`expected an array, got ${typeof value}`);
  return value;
}
