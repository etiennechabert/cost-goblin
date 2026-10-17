import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestListener } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer } from 'node:net';
import type { McpContext } from '../context.js';
import { createMcpHttpServer } from '../http-server.js';

// A start that fails leaves nothing behind: the caller gets no handle to close,
// so a 127.0.0.1 listener left bound would keep serving MCP and fail every
// retry with EADDRINUSE. node:http is mocked pass-through: arming
// `control.ipv6ListenError` makes the ::1 listen fail with that code.

const control = vi.hoisted(() => {
  const state: { ipv6ListenError: string | undefined } = { ipv6ListenError: undefined };
  return state;
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
          const code = control.ipv6ListenError;
          if (host === '::1' && code !== undefined) {
            // As a real bind failure is: an 'error' event on a later tick.
            process.nextTick(() => {
              server.emit('error', Object.assign(new Error(`listen ${code} ::1:${String(port)}`), { code }));
            });
            return server;
          }
          return realListen(port, host, onListening);
        },
      });
      return server;
    },
  };
});

const TOKEN = 'failed-start-test-token-0123456789abcdef';

const unused = (): never => { throw new Error('not used by the listen tests'); };
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

async function occupy(port: number): Promise<NetServer> {
  const blocker = createNetServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(port, '127.0.0.1', resolve);
  });
  return blocker;
}

afterEach(() => {
  control.ipv6ListenError = undefined;
  vi.useRealTimers();
});

describe('a failed start', () => {
  it('releases 127.0.0.1 and stops the reaper when the ::1 listen fails with an error other than "no IPv6"', async () => {
    const port = await freePort();
    control.ipv6ListenError = 'EADDRINUSE';
    // Intervals are faked so the session reaper can be counted.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

    await expect(createMcpHttpServer(ctx, { port, authToken: TOKEN })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();

    // Nothing serves on 127.0.0.1 any more...
    await expect(fetch(`http://127.0.0.1:${String(port)}/health`)).rejects.toMatchObject({ cause: { code: 'ECONNREFUSED' } });
    // ...and the port is free again: a retry binds it.
    control.ipv6ListenError = undefined;
    const retry = await createMcpHttpServer(ctx, { port, authToken: TOKEN });
    await retry.close();
  });

  it('stops the session reaper when the 127.0.0.1 listen fails', async () => {
    const port = await freePort();
    const blocker = await occupy(port);
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await expect(createMcpHttpServer(ctx, { port, authToken: TOKEN })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => { blocker.close(() => { resolve(); }); });
    }
  });
});
