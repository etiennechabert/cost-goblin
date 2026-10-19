import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { QUERY_CANCELLED_MESSAGE } from '@costgoblin/core';
import type { DuckDBClient, RawRow } from '../main/duckdb-client.js';
import { createAppContext, type AppContext, type IpcContext } from '../main/handlers/context.js';

/** The main process collapses identical in-flight queries into one DuckDB
 *  round-trip (`dedup` in handlers/context.ts). A failed or cancelled query
 *  must reach every caller that joined it — each handles the rejection itself
 *  (the explorer's try/catch, cost-scope's allSettled, the savings fallback) —
 *  and nothing else: the main process has no rejection handler of its own, so
 *  a stray rejected promise is a console warning, and a Sentry event once
 *  telemetry is on, for an error the handler already dealt with. */

// context.ts reaches @sentry/electron/main (which imports `electron`) through
// the tracing helper, and neither loads outside Electron. Tracing is never
// armed here, so nothing on either module is called.
vi.mock('electron', () => ({ app: {} }));
vi.mock('@sentry/electron/main', () => ({}));

const SQL = 'SELECT 42 AS answer';
const PARAMS: readonly unknown[] = ['2026-02-01'];
const ROWS: RawRow[] = [{ answer: 42 }];

interface PendingQuery {
  readonly resolve: (rows: RawRow[]) => void;
  readonly reject: (err: Error) => void;
}

interface ScriptedDb extends DuckDBClient {
  /** One entry per DuckDB round-trip, in call order; each stays pending
   *  until the test settles it. */
  readonly queries: readonly PendingQuery[];
  readonly cancelPendingQueries: Mock<() => void>;
}

function createScriptedDb(): ScriptedDb {
  const queries: PendingQuery[] = [];
  const pending = (): Promise<RawRow[]> => new Promise((resolve, reject) => { queries.push({ resolve, reject }); });
  return {
    queries,
    runQuery: () => pending(),
    runPreparedQuery: () => pending(),
    runBuildQuery: () => Promise.reject(new Error('rollup builds are not part of this test')),
    cancelPendingQueries: vi.fn<() => void>(),
    configure: () => undefined,
    terminate: () => Promise.resolve(),
  };
}

function query(db: ScriptedDb, index: number): PendingQuery {
  const pendingQuery = db.queries[index];
  if (pendingQuery === undefined) throw new Error(`expected DuckDB round-trip #${String(index + 1)}`);
  return pendingQuery;
}

/** A context over an empty workspace: no config, so nothing beyond the
 *  queries the test runs ever reaches the DB. */
function ipcContext(root: string, db: DuckDBClient): IpcContext {
  const paths = {
    dataDir: join(root, 'data'),
    configBase: join(root, 'config'),
    stateDir: join(root, 'state'),
    tempDir: join(root, 'tmp'),
  };
  return {
    db,
    syncClient: {
      syncPeriods: () => Promise.reject(new Error('syncs are not part of this test')),
      cancelSync: () => undefined,
      terminate: () => Promise.resolve(),
    },
    configPath: join(paths.configBase, 'costgoblin.yaml'),
    dimensionsPath: join(paths.configBase, 'dimensions.yaml'),
    orgTreePath: join(paths.configBase, 'org-tree.yaml'),
    viewsPath: join(paths.configBase, 'views.yaml'),
    costScopePath: join(paths.configBase, 'cost-scope.yaml'),
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    workspaceEnv: { mode: 'pinned', ...paths },
    duckdbWorkerPath: join(root, 'duckdb-worker.cjs'),
    now: () => Date.parse('2026-03-01T12:00:00Z'),
  };
}

/** Node reports an unhandled rejection once the microtask queue drains, so let
 *  a full macrotask pass before checking that none was reported. */
function nextMacrotask(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve); });
}

interface EntryPoint {
  readonly name: string;
  readonly call: (app: AppContext) => Promise<RawRow[]>;
}

const ENTRY_POINTS: readonly EntryPoint[] = [
  { name: 'runQuery', call: app => app.runQuery(SQL) },
  { name: 'runPreparedQuery', call: app => app.runPreparedQuery(SQL, PARAMS) },
];

describe.each(ENTRY_POINTS)('AppContext.$name in-flight dedup', ({ call }) => {
  const unhandled: unknown[] = [];
  const recordUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  let root: string;
  let db: ScriptedDb;
  let app: AppContext;

  beforeEach(async () => {
    unhandled.length = 0;
    process.on('unhandledRejection', recordUnhandled);
    root = await mkdtemp(join(tmpdir(), 'cg-dedup-'));
    db = createScriptedDb();
    app = createAppContext(ipcContext(root, db));
  });

  afterEach(async () => {
    process.off('unhandledRejection', recordUnhandled);
    await app.awaitWarmup(5_000);
    await rm(root, { recursive: true, force: true });
  });

  it('rejects every caller that joined a failed query, and leaves no rejection unhandled', async () => {
    const first = call(app);
    const joined = call(app);
    expect(joined).toBe(first);
    expect(db.queries).toHaveLength(1);

    query(db, 0).reject(new Error('Binder Error: Referenced column "nope" not found'));
    await expect(first).rejects.toThrow('Referenced column "nope" not found');
    await expect(joined).rejects.toThrow('Referenced column "nope" not found');

    await nextMacrotask();
    expect(unhandled).toEqual([]);
  });

  it('runs the query again after a failure instead of replaying the rejection', async () => {
    const failed = call(app);
    query(db, 0).reject(new Error('IO Error: No files found that match the pattern'));
    await expect(failed).rejects.toThrow('No files found');

    const retried = call(app);
    expect(retried).not.toBe(failed);
    expect(db.queries).toHaveLength(2);
    query(db, 1).resolve(ROWS);
    await expect(retried).resolves.toEqual(ROWS);

    await nextMacrotask();
    expect(unhandled).toEqual([]);
  });

  it('keeps a newer query joinable when one dropped by clearAllCaches settles late', async () => {
    const stale = call(app);
    await app.clearAllCaches();
    expect(db.cancelPendingQueries).toHaveBeenCalledTimes(1);

    const fresh = call(app);
    expect(fresh).not.toBe(stale);
    expect(db.queries).toHaveLength(2);

    // The worker answers the cancel after the fresh query has started: the
    // stale query's cleanup must not evict the fresh one under the same key.
    query(db, 0).reject(new Error(QUERY_CANCELLED_MESSAGE));
    await expect(stale).rejects.toThrow(QUERY_CANCELLED_MESSAGE);
    expect(call(app)).toBe(fresh);
    expect(db.queries).toHaveLength(2);

    query(db, 1).resolve(ROWS);
    await expect(fresh).resolves.toEqual(ROWS);

    await nextMacrotask();
    expect(unhandled).toEqual([]);
  });
});
