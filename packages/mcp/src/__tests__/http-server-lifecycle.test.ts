import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import { logger } from '@costgoblin/core';
import type { LogEntry } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { createMcpHttpServer } from '../http-server.js';
import type { McpHttpServer } from '../http-server.js';

// The HTTP layer around the MCP transport: routing, session reaping, listen
// failures and what a client sees when the SDK transport or the tool
// registration fails. The three mocks below are pass-through until a test
// arms `control`.

const control = vi.hoisted(() => {
  const state: {
    /** Thrown by registerTools, so the new session never connects. */
    registerFailure: { reason: unknown } | undefined;
    /** Thrown by handleRequest for requests carrying `x-test-fail`. */
    handleFailure: unknown;
    /** Rejected by transport.close(), after the transport has closed. */
    closeFailure: { reason: unknown } | undefined;
    /** Every transport.close() call's promise, so a test can wait for one
     *  the server does not await to settle. */
    closes: Promise<void>[];
    /** Error code the ::1 listen fails with. */
    ipv6ListenError: string | undefined;
    /** When set, listen() binds nothing: it records the call and reports success. */
    fakeListens: { port: number; host: string }[] | undefined;
  } = { registerFailure: undefined, handleFailure: undefined, closeFailure: undefined, closes: [], ipv6ListenError: undefined, fakeListens: undefined };
  return state;
});

vi.mock('../tools/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tools/index.js')>();
  return {
    ...actual,
    registerTools: (...args: Parameters<typeof actual.registerTools>): void => {
      const failure = control.registerFailure;
      if (failure !== undefined) throw failure.reason;
      actual.registerTools(...args);
    },
  };
});

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/server/streamableHttp.js')>();
  class ControlledTransport extends actual.StreamableHTTPServerTransport {
    override async handleRequest(req: IncomingMessage, res: ServerResponse, parsedBody?: unknown): Promise<void> {
      const mode = req.headers['x-test-fail'];
      if (mode === 'before-headers') throw control.handleFailure;
      if (mode === 'after-headers') {
        res.writeHead(202, { 'Content-Type': 'text/plain' }).end('partial');
        throw control.handleFailure;
      }
      await super.handleRequest(req, res, parsedBody);
    }

    override close(): Promise<void> {
      const closing = (async () => {
        await super.close();
        const failure = control.closeFailure;
        if (failure !== undefined) throw failure.reason;
      })();
      control.closes.push(closing);
      return closing;
    }
  }
  return { ...actual, StreamableHTTPServerTransport: ControlledTransport };
});

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (listener: RequestListener) => {
      const server = actual.createServer(listener);
      const realListen = server.listen.bind(server);
      Object.defineProperty(server, 'listen', {
        value: (port: number, host: string, onListening: () => void) => {
          const fake = control.fakeListens;
          if (fake !== undefined) {
            fake.push({ port, host });
            setImmediate(onListening);
            return server;
          }
          const code = control.ipv6ListenError;
          if (host === '::1' && code !== undefined) {
            setImmediate(() => { server.emit('error', Object.assign(new Error(`listen ${code} ::1`), { code })); });
            return server;
          }
          return realListen(port, host, onListening);
        },
      });
      return server;
    },
  };
});

const TOKEN = 'lifecycle-test-token-0123456789abcdef';

const logs: LogEntry[] = [];
logger.addHandler((entry) => { logs.push(entry); });

function messages(level: LogEntry['level']): string[] {
  return logs.filter(e => e.level === level).map(e => e.message);
}

const unused = (): never => { throw new Error('not used by the HTTP layer tests'); };
const ctx: McpContext = {
  dataDir: '/nonexistent',
  stateDir: '/nonexistent',
  runQuery: unused,
  runPreparedQuery: unused,
  getConfig: unused,
  getDimensions: unused,
  getQueryDimensions: unused,
  getCostScope: unused,
  getAccountMap: unused,
  getAccountReverseMap: unused,
  getOrgAccountsPath: unused,
  materializedBase: { getSource: () => undefined },
  warmup: () => Promise.resolve(),
  now: () => Date.UTC(2026, 2, 1),
};

/** A port nothing listens on right now (bound to 0, then released). */
async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => { probe.listen(0, '127.0.0.1', resolve); });
  const address = probe.address();
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

async function occupy(port: number, host: string): Promise<NetServer> {
  const blocker = createNetServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, host, resolve);
  });
  return blocker;
}

async function release(blocker: NetServer): Promise<void> {
  await new Promise<void>((resolve) => { blocker.close(() => { resolve(); }); });
}

/** Poll (with real timers) until `check` passes. */
async function eventually(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  throw new Error('condition not reached');
}

const JSON_ACCEPT = { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream' };

function rpcBody(method: string, id?: number): string {
  if (method === 'initialize') {
    return JSON.stringify({
      jsonrpc: '2.0', method, id: id ?? 1,
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'lifecycle', version: '0.0.0' } },
    });
  }
  return JSON.stringify(id === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, id });
}

function mcpUrl(port: number): string {
  return `http://127.0.0.1:${String(port)}/mcp`;
}

function post(port: number, method: string, headers: Record<string, string> = {}, id?: number): Promise<Response> {
  return fetch(mcpUrl(port), {
    method: 'POST',
    headers: { ...JSON_ACCEPT, 'Authorization': `Bearer ${TOKEN}`, ...headers },
    body: rpcBody(method, id),
  });
}

/** Initialize a session and return its id. */
async function openSession(port: number): Promise<string> {
  const res = await post(port, 'initialize');
  expect(res.status).toBe(200);
  await res.text();
  const sessionId = res.headers.get('mcp-session-id');
  if (sessionId === null) throw new Error('no session id');
  const notified = await post(port, 'notifications/initialized', sessionHeaders(sessionId));
  await notified.text();
  return sessionId;
}

function sessionHeaders(sessionId: string): Record<string, string> {
  return { 'Mcp-Session-Id': sessionId, 'Mcp-Protocol-Version': '2025-03-26' };
}

async function listToolsStatus(port: number, sessionId: string): Promise<number> {
  const res = await post(port, 'tools/list', sessionHeaders(sessionId), 7);
  await res.text();
  return res.status;
}

async function errorMessage(res: Response): Promise<unknown> {
  const body: unknown = await res.json();
  if (typeof body !== 'object' || body === null || !('error' in body)) throw new Error('no JSON-RPC error');
  const error: unknown = body.error;
  return typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
}

afterEach(() => {
  control.registerFailure = undefined;
  control.handleFailure = undefined;
  control.closeFailure = undefined;
  control.closes = [];
  control.ipv6ListenError = undefined;
  control.fakeListens = undefined;
  logs.length = 0;
});

describe('startup', () => {
  it('listens on the desktop default port on both loopbacks when no port is given', async () => {
    const listens: { port: number; host: string }[] = [];
    control.fakeListens = listens;
    const server = await createMcpHttpServer(ctx, { authToken: TOKEN });
    expect(server.port).toBe(19532);
    expect(listens).toEqual([{ port: 19532, host: '127.0.0.1' }, { port: 19532, host: '::1' }]);
    await server.close();
  });
});

describe('routing', () => {
  let port: number;
  let server: McpHttpServer;

  beforeAll(async () => {
    port = await freePort();
    server = await createMcpHttpServer(ctx, { port, authToken: TOKEN });
  });

  afterAll(async () => {
    await server.close();
  });

  it('reports the port it listens on', () => {
    expect(server.port).toBe(port);
  });

  it('answers 404 for a path it does not serve', async () => {
    const res = await fetch(`http://127.0.0.1:${String(port)}/metrics`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('');
  });

  it('answers 404 for a method /mcp does not take', async () => {
    const res = await fetch(mcpUrl(port), { method: 'PUT', headers: { 'Authorization': `Bearer ${TOKEN}` }, body: '{}' });
    expect(res.status).toBe(404);
  });

  it.each(['GET', 'DELETE'])('answers 400 to an authenticated %s without a known session', async (method) => {
    const res = await fetch(mcpUrl(port), {
      method,
      headers: { 'Accept': 'application/json, text/event-stream', 'Authorization': `Bearer ${TOKEN}`, ...sessionHeaders('no-such-session') },
    });
    expect(res.status).toBe(400);
    expect(await errorMessage(res)).toBe('Bad Request: No valid session');
  });

  it('still checks the token before the session lookup on GET', async () => {
    const res = await fetch(mcpUrl(port), { method: 'GET', headers: { 'Authorization': 'Bearer short' } });
    expect(res.status).toBe(401);
  });

  it('serves an established session', async () => {
    const sessionId = await openSession(port);
    expect(await listToolsStatus(port, sessionId)).toBe(200);
    expect(messages('info')).toContain('mcp: session created');
  });
});

describe('listen failures', () => {
  it('rejects when the IPv4 port is already taken', async () => {
    const port = await freePort();
    const blocker = await occupy(port, '127.0.0.1');
    try {
      await expect(createMcpHttpServer(ctx, { port, authToken: TOKEN })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await release(blocker);
    }
  });

  it.each(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])('serves IPv4 alone when the IPv6 loopback fails with %s', async (code) => {
    control.ipv6ListenError = code;
    const port = await freePort();
    const server = await createMcpHttpServer(ctx, { port, authToken: TOKEN });
    try {
      expect(messages('info')).toContain('mcp: IPv6 loopback unavailable, skipping');
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe('transport and connect failures', () => {
  let port: number;
  let server: McpHttpServer;

  beforeAll(async () => {
    port = await freePort();
    server = await createMcpHttpServer(ctx, { port, authToken: TOKEN });
  });

  afterAll(async () => {
    await server.close();
  });

  it.each([
    ['an Error', new Error('stream reset'), 'mcp: transport error — stream reset'],
    ['a thrown string', 'socket gone', 'mcp: transport error — socket gone'],
  ])('answers 500 when a new session transport throws %s', async (_label, failure, logged) => {
    control.handleFailure = failure;
    const res = await post(port, 'initialize', { 'x-test-fail': 'before-headers' });
    expect(res.status).toBe(500);
    expect(messages('warn')).toEqual([logged]);
  });

  it('keeps the response a new session transport already started', async () => {
    control.handleFailure = new Error('late failure');
    const res = await post(port, 'initialize', { 'x-test-fail': 'after-headers' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('partial');
    expect(messages('warn')).toEqual(['mcp: transport error — late failure']);
  });

  it.each([
    ['an Error', new Error('stream reset'), 'mcp: transport error — stream reset'],
    ['a thrown string', 'socket gone', 'mcp: transport error — socket gone'],
  ])('answers 500 when an established session transport throws %s', async (_label, failure, logged) => {
    const sessionId = await openSession(port);
    control.handleFailure = failure;
    const res = await post(port, 'tools/list', { ...sessionHeaders(sessionId), 'x-test-fail': 'before-headers' }, 3);
    expect(res.status).toBe(500);
    expect(messages('warn')).toEqual([logged]);
    // The session survives a failed request.
    expect(await listToolsStatus(port, sessionId)).toBe(200);
  });

  it('keeps the response an established session transport already started', async () => {
    const sessionId = await openSession(port);
    control.handleFailure = new Error('late failure');
    const res = await post(port, 'tools/list', { ...sessionHeaders(sessionId), 'x-test-fail': 'after-headers' }, 4);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('partial');
    expect(messages('warn')).toEqual(['mcp: transport error — late failure']);
  });

  it.each([
    ['an Error', new Error('registry broken'), 'mcp: connect error — registry broken'],
    ['a thrown string', 'no tools', 'mcp: connect error — no tools'],
  ])('answers 500 and creates no session when connecting throws %s', async (_label, reason, logged) => {
    control.registerFailure = { reason };
    const res = await post(port, 'initialize');
    expect(res.status).toBe(500);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    await eventually(() => messages('warn').length > 0);
    expect(messages('warn')).toEqual([logged]);
    expect(messages('info')).not.toContain('mcp: session created');
  });

  it('still answers 500 when closing the half-connected transport fails too', async () => {
    control.registerFailure = { reason: new Error('registry broken') };
    control.closeFailure = { reason: new Error('close failed') };
    const res = await post(port, 'initialize');
    expect(res.status).toBe(500);
    // The server does not await that close, so let it settle first: the
    // server's own catch is attached before ours, so once allSettled resolves
    // anything that catch logs is already in the list.
    expect(control.closes).toHaveLength(1);
    await Promise.allSettled(control.closes);
    // The close failure is swallowed: only the connect error is logged.
    expect(messages('warn')).toEqual(['mcp: connect error — registry broken']);
  });
});

describe('idle session reaping', () => {
  const MINUTE = 60_000;
  let port: number;
  let server: McpHttpServer;

  beforeAll(async () => {
    // Only the reaper's interval and the activity clock are faked: the HTTP
    // round trips below still run on real timers.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    port = await freePort();
    server = await createMcpHttpServer(ctx, { port, authToken: TOKEN });
  });

  afterAll(async () => {
    await server.close();
    vi.useRealTimers();
  });

  /** True when the server no longer knows the session. A GET on a live session
   *  would open an SSE stream, so anything but the 400 is cancelled at once. */
  async function isGone(sessionId: string): Promise<boolean> {
    const res = await fetch(mcpUrl(port), {
      method: 'GET',
      headers: { 'Accept': 'text/event-stream', 'Authorization': `Bearer ${TOKEN}`, ...sessionHeaders(sessionId) },
    });
    if (res.status !== 400) {
      await res.body?.cancel();
      return false;
    }
    return await errorMessage(res) === 'Bad Request: No valid session';
  }

  async function closeSession(sessionId: string): Promise<void> {
    const res = await fetch(mcpUrl(port), {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${TOKEN}`, ...sessionHeaders(sessionId) },
    });
    await res.text();
    expect(res.status).toBe(200);
  }

  it('drops a session idle for more than 30 minutes and keeps an active one', async () => {
    const idle = await openSession(port);
    const active = await openSession(port);

    vi.advanceTimersByTime(20 * MINUTE);
    expect(await listToolsStatus(port, active)).toBe(200);

    // The idle session is exactly 30 minutes old here: not yet reaped.
    vi.advanceTimersByTime(10 * MINUTE);
    expect(messages('info')).not.toContain('mcp: reaping idle session');

    vi.advanceTimersByTime(MINUTE);
    expect(logs.filter(e => e.message === 'mcp: reaping idle session').map(e => e.context)).toEqual([{ sessionId: idle }]);
    expect(await isGone(idle)).toBe(true);
    expect(await listToolsStatus(port, active)).toBe(200);
    await eventually(() => messages('info').includes('mcp: session removed'));

    // A client DELETE ends the active session through the transport's onclose.
    await closeSession(active);
    expect(messages('info')).toContain('mcp: session closed');
    expect(await isGone(active)).toBe(true);
  });

  it.each([
    ['an Error', new Error('close failed'), 'mcp: session close error — close failed'],
    ['a thrown number', 42, 'mcp: session close error — 42'],
  ])('logs %s from closing a reaped session', async (_label, reason, logged) => {
    const sessionId = await openSession(port);
    control.closeFailure = { reason };
    vi.advanceTimersByTime(31 * MINUTE);
    await eventually(() => messages('warn').length > 0);
    expect(messages('warn')).toEqual([logged]);
    expect(await isGone(sessionId)).toBe(true);
  });
});
