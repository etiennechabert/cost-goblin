import { randomUUID, timingSafeEqual } from 'node:crypto';
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

export interface McpHttpServerOptions {
  readonly port?: number | undefined;
  /** Shared secret required on every /mcp request. When set, callers must send
   *  it as `Authorization: Bearer <token>` or a `?token=<token>` query param.
   *  When undefined the server is open (used only in tests). */
  readonly authToken?: string | undefined;
}

interface SessionEntry {
  readonly transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

/** Constant-time token comparison. Returns false on any length mismatch without
 *  leaking it through timing. */
function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull the caller's token from the Authorization header (preferred) or a
 *  `token` query param (for clients that can only be given a URL). */
function extractToken(req: IncomingMessage, rawUrl: string): string | undefined {
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(\S.*)$/i.exec(auth.trim());
    if (match?.[1] !== undefined) return match[1].trim();
  }
  const qIndex = rawUrl.indexOf('?');
  if (qIndex >= 0) {
    const token = new URLSearchParams(rawUrl.slice(qIndex + 1)).get('token');
    if (token !== null) return token;
  }
  return undefined;
}

export async function createMcpHttpServer(ctx: McpContext, options?: McpHttpServerOptions): Promise<McpHttpServer> {
  const resolvedPort = options?.port ?? DEFAULT_PORT;
  const authToken = options?.authToken;
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

  // Only loopback Host headers are accepted. The server binds 127.0.0.1/::1, but
  // a Host check is still needed to defeat DNS rebinding: a browser tricked into
  // resolving an attacker domain to 127.0.0.1 would send that domain in Host, so
  // rejecting non-loopback Hosts stops a malicious web page from driving the
  // (unauthenticated) MCP tools against the user's local data.
  const allowedHosts = new Set<string>();
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) {
    allowedHosts.add(h);
    allowedHosts.add(`${h}:${String(resolvedPort)}`);
  }
  function isAllowedHost(hostHeader: string | undefined): boolean {
    return hostHeader !== undefined && allowedHosts.has(hostHeader.toLowerCase());
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '';
    const pathname = url.split('?')[0] ?? url;

    if (!isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden: invalid Host header' }, id: null }));
      return;
    }

    // /health stays open as an unauthenticated liveness probe (no data).
    if (pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"status":"ok"}');
      return;
    }

    if (pathname === '/mcp' && (req.method === 'POST' || req.method === 'GET' || req.method === 'DELETE')) {
      if (authToken !== undefined && !tokenMatches(extractToken(req, url), authToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or invalid token' }, id: null }));
        return;
      }
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
