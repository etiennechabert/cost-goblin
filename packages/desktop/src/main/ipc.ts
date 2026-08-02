import { createAppContext, type AppContext, type IpcContext } from './handlers/context.js';
import { registerQueryHandlers } from './handlers/query.js';
import { registerSyncHandlers } from './handlers/sync.js';
import { registerConfigHandlers } from './handlers/config.js';
import { registerSetupHandlers } from './handlers/setup.js';
import { registerDimensionsHandlers } from './handlers/dimensions.js';
import { registerSavingsHandlers } from './handlers/savings.js';
import { registerUIHandlers } from './handlers/ui.js';
import { registerOrgHandlers } from './handlers/org.js';
import { registerAutoSyncHandlers } from './handlers/auto-sync.js';
import { registerViewsHandlers } from './handlers/views.js';
import { registerCostScopeHandlers } from './handlers/cost-scope.js';
import { registerSharingHandlers } from './handlers/sharing.js';
import { registerDataSharingHandlers } from './handlers/data-sharing.js';
import { registerExplorerHandlers } from './handlers/explorer.js';
import { registerDebugHandlers } from './handlers/debug.js';
import { registerMcpHandlers } from './handlers/mcp-handler.js';
import { registerRollupHandlers } from './handlers/rollup.js';
import { registerBaselinesHandlers } from './handlers/baselines.js';
import { registerTelemetryHandlers } from './handlers/telemetry.js';
import { registerSyncLogHandlers } from './handlers/sync-log.js';
import { registerWorkspacesHandlers } from './handlers/workspaces.js';

export type { AppContext, IpcContext } from './handlers/context.js';

export function registerIpcHandlers(ctx: IpcContext): AppContext {
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
  registerViewsHandlers(app);
  registerCostScopeHandlers(app);
  registerSharingHandlers(app);
  registerDataSharingHandlers(app);
  registerExplorerHandlers(app);
  registerDebugHandlers(app);
  registerMcpHandlers(app);
  registerRollupHandlers(app);
  registerBaselinesHandlers(app);
  registerTelemetryHandlers(app);
  registerSyncLogHandlers();
  registerWorkspacesHandlers(app);

  app.warmupBase();

  return app;
}
