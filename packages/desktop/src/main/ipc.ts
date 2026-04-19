import { logger } from '@costgoblin/core';
import { createAppContext, type IpcContext } from './handlers/context.js';
import { registerQueryHandlers } from './handlers/query.js';
import { registerSyncHandlers } from './handlers/sync.js';
import { registerConfigHandlers } from './handlers/config.js';
import { registerSetupHandlers } from './handlers/setup.js';
import { registerDimensionsHandlers } from './handlers/dimensions.js';
import { registerSavingsHandlers } from './handlers/savings.js';
import { registerUIHandlers } from './handlers/ui.js';
import { registerOrgHandlers } from './handlers/org.js';
import { registerAutoSyncHandlers } from './handlers/auto-sync.js';
import { enqueueStartupMigration } from './startup-migrate.js';

export type { IpcContext };

export function registerIpcHandlers(ctx: IpcContext): void {
  const app = createAppContext(ctx);
  registerQueryHandlers(app);
  registerSyncHandlers(app);
  registerConfigHandlers(app);
  registerSetupHandlers(app);
  registerDimensionsHandlers(app);
  registerSavingsHandlers(app);
  registerUIHandlers(app);
  registerOrgHandlers(app);
  registerAutoSyncHandlers(app);

  // Kick off background optimization for any raw files that aren't yet
  // sorted + sidecar'd. Idempotent — skips already-optimized files. Runs in
  // parallel with queries (queries fall back to element_at meanwhile).
  void app.getDimensions()
    .then(dims => enqueueStartupMigration(ctx.dataDir, dims.tags, app.optimizeQueue))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`startup migration skipped: ${message}`);
    });
}
