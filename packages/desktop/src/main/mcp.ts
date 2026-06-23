import { app as electronApp } from 'electron';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import { createMcpHttpServer } from '@costgoblin/mcp';
import type { McpContext, McpHttpServer } from '@costgoblin/mcp';
import type { AppContext } from './handlers/context.js';
import { loadOrCreateMcpToken, regenerateMcpToken as rotateTokenFile } from './mcp-token.js';

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
    // The rollup is daily/dashboard-shaped; MCP queries are arbitrary SQL, so
    // they always read raw. (McpContext wants a structural getSource provider.)
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
  };
}

function tokenPath(): string {
  return join(electronApp.getPath('userData'), 'mcp-auth-token');
}

let currentToken: string | null = null;

/** The shared secret an AI client must present to reach the MCP server. Loaded
 *  (and created on first use) lazily so the view can show it before the server
 *  is even started. */
export function getMcpToken(): string {
  currentToken ??= loadOrCreateMcpToken(tokenPath());
  return currentToken;
}

let server: McpHttpServer | null = null;
let lastApp: AppContext | null = null;

export async function startMcpServer(app: AppContext): Promise<void> {
  lastApp = app;
  const mcpCtx = adaptAppContext(app);
  const envPort = process.env['COSTGOBLIN_MCP_PORT'];
  const port = envPort !== undefined && envPort.length > 0 ? Number(envPort) : undefined;
  server = await createMcpHttpServer(mcpCtx, { port, authToken: getMcpToken() });
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

/** Rotate the token and, if the server is running, restart it so the new token
 *  takes effect immediately (existing sessions are dropped). Returns the new
 *  token for the UI to display. */
export async function regenerateMcpToken(): Promise<string> {
  currentToken = rotateTokenFile(tokenPath());
  if (server !== null && lastApp !== null) {
    await stopMcpServer();
    await startMcpServer(lastApp);
  }
  return currentToken;
}
