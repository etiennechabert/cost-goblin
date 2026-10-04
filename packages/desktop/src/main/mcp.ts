import { app as electronApp } from 'electron';
import { join } from 'node:path';
import { logger } from '@costgoblin/core';
import { createMcpHttpServer } from '@costgoblin/mcp';
import type { McpContext, McpHttpServer } from '@costgoblin/mcp';
import { createDuckDBClient } from './duckdb-client.js';
import type { DuckDBClient } from './duckdb-client.js';
import type { AppContext } from './handlers/context.js';
import { prepareMcpSandbox, sandboxedQueryFns } from './mcp-sandbox.js';
import { loadOrCreateMcpToken, regenerateMcpToken as rotateTokenFile } from './mcp-token.js';

/** MCP tools run SQL an AI client controls, so every MCP query goes to the
 *  dedicated sandboxed instance (`mcpDb`), never the app's shared one. */
function adaptAppContext(app: AppContext, mcpDb: DuckDBClient): McpContext {
  const { runQuery, runPreparedQuery } = sandboxedQueryFns(mcpDb);
  return {
    dataDir: app.ctx.dataDir,
    stateDir: app.ctx.stateDir,
    runQuery,
    runPreparedQuery,
    getConfig: () => app.getConfig(),
    getDimensions: () => app.getDimensions(),
    getQueryDimensions: () => app.getQueryDimensions(),
    getCostScope: () => app.getCostScope(),
    getAccountMap: () => app.getAccountMap(),
    getAccountReverseMap: () => app.getAccountReverseMap(),
    getOrgAccountsPath: () => app.getOrgAccountsPath(),
    // The rollup is daily/dashboard-shaped; MCP queries are arbitrary SQL, so
    // they always read raw. (McpContext wants a structural getSource provider.)
    materializedBase: { getSource: () => undefined },
    warmup: () => Promise.resolve(),
    now: app.ctx.now,
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

/** The HTTP server and its dedicated DuckDB worker live and die together. */
interface RunningMcp {
  readonly server: McpHttpServer;
  readonly db: DuckDBClient;
}

let running: RunningMcp | null = null;
let lastApp: AppContext | null = null;

// Start / stop / token rotation are serialized: the auto-start at launch, the
// mcp:set-running toggle and regenerateMcpToken can overlap, and an unserialized
// overlap could spawn a second sandboxed worker (or HTTP server) and orphan one.
let lifecycleTail: Promise<unknown> = Promise.resolve();

function serialized<T>(op: () => Promise<T>): Promise<T> {
  const result = lifecycleTail.then(op, op);
  lifecycleTail = result.catch(() => undefined);
  return result;
}

async function doStart(app: AppContext): Promise<void> {
  if (running !== null) return;
  lastApp = app;
  // Fail closed: if the sandbox can't be prepared or applied, MCP doesn't start
  // (createDuckDBClient rejects with its worker already terminated).
  const sandbox = prepareMcpSandbox({
    dataDir: app.ctx.dataDir,
    stateDir: app.ctx.stateDir,
    tempDir: app.ctx.workspaceEnv.tempDir,
  });
  const db = await createDuckDBClient(app.ctx.duckdbWorkerPath, { sandbox });
  let server: McpHttpServer;
  try {
    const envPort = process.env['COSTGOBLIN_MCP_PORT'];
    const port = envPort !== undefined && envPort.length > 0 ? Number(envPort) : undefined;
    server = await createMcpHttpServer(adaptAppContext(app, db), { port, authToken: getMcpToken() });
  } catch (err: unknown) {
    await db.terminate().catch(() => undefined);
    throw err;
  }
  running = { server, db };
  logger.info('mcp: embedded server started (sandboxed DuckDB instance)', { port: server.port });
}

async function doStop(): Promise<void> {
  if (running === null) return;
  const { server, db } = running;
  running = null;
  try {
    await server.close();
  } finally {
    await db.terminate();
  }
}

export function startMcpServer(app: AppContext): Promise<void> {
  return serialized(() => doStart(app));
}

export function stopMcpServer(): Promise<void> {
  return serialized(doStop);
}

export function isMcpServerRunning(): boolean {
  return running !== null;
}

/** Rotate the token and, if the server is running, restart it so the new token
 *  takes effect immediately (existing sessions are dropped). Returns the new
 *  token for the UI to display. */
export function regenerateMcpToken(): Promise<string> {
  return serialized(async () => {
    const token = rotateTokenFile(tokenPath());
    currentToken = token;
    if (running !== null && lastApp !== null) {
      await doStop();
      await doStart(lastApp);
    }
    return token;
  });
}
