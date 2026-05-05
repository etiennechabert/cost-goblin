import { logger } from '@costgoblin/core';
import { createMcpHttpServer } from '@costgoblin/mcp';
import type { McpContext, McpHttpServer } from '@costgoblin/mcp';
import type { AppContext } from './handlers/context.js';

function adaptAppContext(app: AppContext): McpContext {
  return {
    dataDir: app.ctx.dataDir,
    runQuery: (sql) => app.runQuery(sql),
    runPreparedQuery: (sql, params) => app.runPreparedQuery(sql, params),
    getConfig: () => app.getConfig(),
    getDimensions: () => app.getDimensions(),
    getQueryDimensions: () => app.getQueryDimensions(),
    getCostScope: () => app.getCostScope(),
    getAccountMap: () => app.getAccountMap(),
    getAccountReverseMap: () => app.getAccountReverseMap(),
    getOrgAccountsPath: () => app.getOrgAccountsPath(),
    getAvailableColumns: (tier) => app.getAvailableColumns(tier),
    materializedBase: app.materializedBase,
    warmup: () => Promise.resolve(),
  };
}

let server: McpHttpServer | null = null;

export async function startMcpServer(app: AppContext): Promise<void> {
  const mcpCtx = adaptAppContext(app);
  const envPort = process.env['COSTGOBLIN_MCP_PORT'];
  const port = envPort !== undefined && envPort.length > 0 ? Number(envPort) : undefined;
  server = await createMcpHttpServer(mcpCtx, port);
  logger.info('mcp: embedded server started', { port: server.port });
}

export async function stopMcpServer(): Promise<void> {
  if (server !== null) {
    await server.close();
    server = null;
  }
}

export function isMcpServerRunning(): boolean {
  return server !== null;
}
