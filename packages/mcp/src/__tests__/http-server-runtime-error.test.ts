import { afterEach, describe, expect, it, vi } from 'vitest';
import { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { logger } from '@costgoblin/core';
import type { LogEntry } from '@costgoblin/core';
import type { McpContext } from '../context.js';
import { createMcpHttpServer } from '../http-server.js';

// A listening server still emits 'error', for one when an accept fails (EMFILE
// once the process is out of file descriptors). With no listener that error is
// thrown, in the desktop app's main process. The started servers are reached
// through a call-through spy on listen().

const TOKEN = 'runtime-error-test-token-0123456789abcdef';

const logs: LogEntry[] = [];
logger.addHandler((entry) => { logs.push(entry); });

const unused = (): never => { throw new Error('not used by the listener tests'); };
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

function hostOf(server: Server): string {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('not a TCP listener');
  return address.address;
}

afterEach(() => {
  vi.restoreAllMocks();
  logs.length = 0;
});

describe('a listening server', () => {
  it('logs an error it emits and keeps serving', async () => {
    const port = await freePort();
    const listen = vi.spyOn(Server.prototype, 'listen');
    const server = await createMcpHttpServer(ctx, { port, authToken: TOKEN });
    try {
      // 127.0.0.1, plus ::1 where the host has an IPv6 loopback.
      const started = listen.mock.contexts.filter((s): s is Server => s instanceof Server && s.listening);
      const hosts = started.map(hostOf);
      expect(hosts).toContain('127.0.0.1');

      for (const s of started) {
        s.emit('error', Object.assign(new Error('accept EMFILE'), { code: 'EMFILE', syscall: 'accept' }));
      }

      expect(logs.filter(e => e.level === 'warn').map(e => e.message))
        .toEqual(hosts.map((h) => `mcp: ${h} listener error — accept EMFILE`));
      const res = await fetch(`http://127.0.0.1:${String(port)}/health`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
