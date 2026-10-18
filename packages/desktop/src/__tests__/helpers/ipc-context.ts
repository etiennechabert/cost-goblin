import { join } from 'node:path';
import type { DuckDBClient } from '../../main/duckdb-client.js';
import type { IpcContext } from '../../main/handlers/context.js';

/** A pinned workspace under `root` (config, data, state and temp dirs), with
 *  `db` as its DuckDB and syncs refused. Nothing is created on disk: the test
 *  writes whatever config or data it needs. */
export function pinnedIpcContext(root: string, db: DuckDBClient): IpcContext {
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
