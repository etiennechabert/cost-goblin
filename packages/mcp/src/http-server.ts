import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { logger } from '@costgoblin/core';
import type { McpContext } from './context.js';
import { registerTools } from './tools/index.js';

const DEFAULT_PORT = 19532;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REAP_INTERVAL_MS = 60 * 1000;    // check every minute

export interface McpHttpServer {
  readonly port: number;
  close(): Promise<void>;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

export async function createMcpHttpServer(ctx: McpContext, port?: number): Promise<McpHttpServer> {
  const resolvedPort = port ?? DEFAULT_PORT;
  const sessions = new Map<string, SessionEntry>();

  function removeSession(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    sessions.delete(sessionId);
    entry.transport.close().catch((err: unknown) => {
      logger.warn(`mcp: session close error — ${err instanceof Error ? err.message : String(err)}`);
    });
    logger.info('mcp: session removed', { sessionId });
  }

  function touchSession(sessionId: string): void {
    const entry = sessions.get(sessionId);
    if (entry !== undefined) entry.lastActivity = Date.now();
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const [sid, entry] of sessions) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        logger.info('mcp: reaping idle session', { sessionId: sid });
        removeSession(sid);
      }
    }
  }, REAP_INTERVAL_MS);
  reaper.unref();

  function createSessionTransport(): StreamableHTTPServerTransport {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, lastActivity: Date.now() });
        logger.info('mcp: session created', { sessionId });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid !== undefined) {
        sessions.delete(sid);
        logger.info('mcp: session closed', { sessionId: sid });
      }
    };

    return transport;
  }

  async function connectTransport(transport: StreamableHTTPServerTransport): Promise<void> {
    const mcpServer = new McpServer(
      { name: 'costgoblin', version: '0.1.0' },
      { capabilities: { tools: {} } },
    );
    registerTools(mcpServer, ctx);
    await mcpServer.connect(transport as unknown as Transport);
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '';

    if (url === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      const sessionId = req.headers['mcp-session-id'];
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

      if (existing !== undefined) {
        touchSession(sessionId as string);
        existing.transport.handleRequest(req, res).catch((err: unknown) => {
          logger.warn(`mcp: transport error — ${err instanceof Error ? err.message : String(err)}`);
          if (!res.headersSent) {
            res.writeHead(500).end();
          }
        });
        return;
      }

      if (req.method === 'POST') {
        const transport = createSessionTransport();
        connectTransport(transport).then(() => {
          transport.handleRequest(req, res).catch((err: unknown) => {
            logger.warn(`mcp: transport error — ${err instanceof Error ? err.message : String(err)}`);
            if (!res.headersSent) {
              res.writeHead(500).end();
            }
          });
        }).catch((err: unknown) => {
          logger.warn(`mcp: connect error — ${err instanceof Error ? err.message : String(err)}`);
          transport.close().catch(() => {});
          if (!res.headersSent) {
            res.writeHead(500).end();
          }
        });
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Bad Request: No valid session' }, id: null }));
      return;
    }

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }

    res.writeHead(404).end();
  };

  // `localhost` resolves to ::1 or 127.0.0.1 depending on the client; bind both so loopback works either way.
  const ipv4Server: Server = createServer(requestHandler);
  const ipv6Server: Server = createServer(requestHandler);

  async function listen(server: Server, host: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        if (host === '::1' && (err.code === 'EAFNOSUPPORT' || err.code === 'EADDRNOTAVAIL')) {
          logger.info('mcp: IPv6 loopback unavailable, skipping');
          resolve();
          return;
        }
        reject(err);
      };
      server.once('error', onError);
      server.listen(resolvedPort, host, () => {
        server.off('error', onError);
        resolve();
      });
    });
  }

  await listen(ipv4Server, '127.0.0.1');
  await listen(ipv6Server, '::1');

  return {
    port: resolvedPort,
    async close(): Promise<void> {
      clearInterval(reaper);
      const closePromises = [...sessions.values()].map((e) => e.transport.close());
      await Promise.all(closePromises);
      sessions.clear();
      await Promise.all([
        new Promise<void>((resolve) => { ipv4Server.close(() => { resolve(); }); }),
        new Promise<void>((resolve) => { ipv6Server.close(() => { resolve(); }); }),
      ]);
    },
  };
}
