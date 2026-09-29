import { describe, it, expect } from 'vitest';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { generateIdentityKeyPair, type IdentityKeyPair } from '../peer/identity.js';
import {
  parseSignedManifest,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  verifyManifestSignature,
  type PackManifest,
} from '../peer/pack-manifest.js';
import {
  startSharingServer,
  type SharingAccessEvent,
  type SharingServer,
  type SharingServerConfig,
  type SharingServerHandlers,
} from '../peer/secure-server.js';
import { fetchFile, fetchManifest } from '../peer/secure-client.js';
import {
  SHARING_PSK_IDENTITY,
  SHARING_TLS_CIPHERS,
  SHARING_TLS_MAX_VERSION,
  SHARING_TLS_MIN_VERSION,
} from '../peer/tls-psk.js';

const files = new Map<string, Buffer>([
  ['aws/raw/daily-2026-06/part-0.parquet', Buffer.from('parquet-A-bytes')],
  ['aws/raw/daily-2026-06/part-1.parquet', Buffer.from('parquet-B-bytes')],
]);

function buildManifest(publisher: string): PackManifest {
  return {
    v: 1,
    createdAt: '2026-06-21T00:00:00.000Z',
    publisher,
    label: 'Test Publisher',
    configBundle: 'kind: costgoblin-config-bundle\n',
    enrichment: { orgAccounts: '{"accounts":[]}', regionNames: null, orgAccountTags: null },
    files: [...files].map(([path, buf]) => ({ path, size: buf.length, sha256: sha256Hex(buf) })),
  };
}

describe('encrypted peer transport (TLS-PSK)', () => {
  it('pulls and verifies a signed snapshot over an encrypted channel', async () => {
    const id = generateIdentityKeyPair();
    const psk = Buffer.from('shared-access-secret-0123456789ab');
    const signed = signManifest(buildManifest(id.publicKey), id.privateKey);
    const accesses: SharingAccessEvent[] = [];

    const server = await startSharingServer(
      { psk, host: '127.0.0.1', onAccess: (e) => accesses.push(e) },
      {
        getManifest: () => serializeSignedManifest(signed),
        readFile: (p) => {
          const buf = files.get(p);
          if (buf === undefined) throw new Error(`unknown file ${p}`);
          return Promise.resolve(buf);
        },
      },
    );

    try {
      const endpoint = { host: '127.0.0.1', port: server.port, psk };
      const parsed = parseSignedManifest(await fetchManifest(endpoint));

      expect(verifyManifestSignature(parsed)).toBe(true);
      expect(parsed.manifest.publisher).toBe(id.publicKey);

      for (const entry of parsed.manifest.files) {
        const buf = await fetchFile(endpoint, entry.path);
        expect(sha256Hex(buf)).toBe(entry.sha256);
      }
    } finally {
      await server.close();
    }

    // Publisher-side feedback fired for the manifest and each file.
    expect(accesses.some(a => a.kind === 'manifest')).toBe(true);
    expect(accesses.filter(a => a.kind === 'file')).toHaveLength(files.size);
  });

  it('reports served byte counts and observes peer connections', async () => {
    const id = generateIdentityKeyPair();
    const psk = Buffer.from('shared-access-secret-0123456789ab');
    const signed = signManifest(buildManifest(id.publicKey), id.privateKey);
    const body = serializeSignedManifest(signed);
    const accesses: SharingAccessEvent[] = [];
    const connectionCounts: number[] = [];

    const server = await startSharingServer(
      {
        psk,
        host: '127.0.0.1',
        onAccess: (e) => accesses.push(e),
        onConnectionsChanged: (n) => connectionCounts.push(n),
      },
      {
        getManifest: () => body,
        readFile: (p) => {
          const buf = files.get(p);
          if (buf === undefined) throw new Error(`unknown file ${p}`);
          return Promise.resolve(buf);
        },
      },
    );

    try {
      const endpoint = { host: '127.0.0.1', port: server.port, psk };
      await fetchManifest(endpoint);
      for (const entry of signed.manifest.files) {
        await fetchFile(endpoint, entry.path);
      }
    } finally {
      await server.close();
    }

    // Manifest byte count matches the serialized body.
    const manifestAccess = accesses.find(a => a.kind === 'manifest');
    expect(manifestAccess?.bytes).toBe(Buffer.byteLength(body));
    // Each file's reported byte count matches its actual size.
    const fileBytes = accesses.filter(a => a.kind === 'file').map(a => a.bytes).sort((x, y) => x - y);
    const expected = [...files.values()].map(b => b.length).sort((x, y) => x - y);
    expect(fileBytes).toEqual(expected);
    // At least one authenticated peer connection was observed.
    expect(Math.max(0, ...connectionCounts)).toBeGreaterThanOrEqual(1);
  });

  it('rejects a client presenting the wrong psk', async () => {
    const id = generateIdentityKeyPair();
    const server = await startSharingServer(
      { psk: Buffer.from('correct-secret-aaaaaaaaaaaaaaaaaa'), host: '127.0.0.1' },
      {
        getManifest: () => serializeSignedManifest(signManifest(buildManifest(id.publicKey), id.privateKey)),
        readFile: () => Promise.resolve(Buffer.alloc(0)),
      },
    );

    try {
      await expect(
        fetchManifest({ host: '127.0.0.1', port: server.port, psk: Buffer.from('WRONG-secret-bbbbbbbbbbbbbbbbbbbb') }),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('aborts a file transfer that exceeds the requested byte cap', async () => {
    const id = generateIdentityKeyPair();
    const psk = Buffer.from('shared-access-secret-0123456789ab');
    const server = await startSharingServer(
      { psk, host: '127.0.0.1' },
      {
        getManifest: () => serializeSignedManifest(signManifest(buildManifest(id.publicKey), id.privateKey)),
        readFile: (p) => {
          const buf = files.get(p);
          if (buf === undefined) throw new Error(`unknown file ${p}`);
          return Promise.resolve(buf);
        },
      },
    );

    try {
      const endpoint = { host: '127.0.0.1', port: server.port, psk };
      const path = 'aws/raw/daily-2026-06/part-0.parquet';
      const size = files.get(path)?.length ?? 0;
      // A cap below the true size (a publisher under-reporting its file) aborts.
      await expect(fetchFile(endpoint, path, size - 1)).rejects.toThrow();
      // The honest advertised size still transfers fully.
      expect(await fetchFile(endpoint, path, size)).toHaveLength(size);
    } finally {
      await server.close();
    }
  });

  it('rejects a request for a path outside the data tree', async () => {
    const id = generateIdentityKeyPair();
    const psk = Buffer.from('shared-access-secret-0123456789ab');
    const server = await startSharingServer(
      { psk, host: '127.0.0.1' },
      {
        getManifest: () => serializeSignedManifest(signManifest(buildManifest(id.publicKey), id.privateKey)),
        readFile: () => Promise.resolve(Buffer.from('should-not-reach')),
      },
    );

    try {
      await expect(
        fetchFile({ host: '127.0.0.1', port: server.port, psk }, '../../etc/passwd'),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Listener lifetime + resource bounds (#605). Real 127.0.0.1 sockets and small
// real timeouts — no fake timers, since the behaviour under test is the
// interplay of Node's socket/TLS timers with our own.
//
// PITFALL: fetchManifest goes through https.globalAgent, which keeps sockets
// alive (Node >= 19). A second request to a port already used can reuse the
// authenticated socket, so a "wrong psk" request there would falsely pass —
// negative handshake checks below use a fresh server and a raw tls.connect.
// ---------------------------------------------------------------------------

const PSK = Buffer.from('shared-access-secret-0123456789ab');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

/** Resolve true once `check` holds, false if `timeoutMs` elapses first. */
async function eventually(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await sleep(10);
  }
  return check();
}

function handlersFor(publisher: IdentityKeyPair, readDelayMs: number): SharingServerHandlers {
  const body = serializeSignedManifest(signManifest(buildManifest(publisher.publicKey), publisher.privateKey));
  return {
    getManifest: () => body,
    readFile: async (p) => {
      const buf = files.get(p);
      if (buf === undefined) throw new Error(`unknown file ${p}`);
      if (readDelayMs > 0) await sleep(readDelayMs);
      return buf;
    },
  };
}

function startTestServer(extra: Omit<SharingServerConfig, 'psk' | 'host'>, readDelayMs = 0): Promise<SharingServer> {
  return startSharingServer({ psk: PSK, host: '127.0.0.1', ...extra }, handlersFor(generateIdentityKeyPair(), readDelayMs));
}

interface RawClient {
  readonly socket: Socket;
  readonly closed: () => boolean;
}

/** Open a plain TCP connection that never starts a TLS handshake. */
function openRawSocket(port: number): Promise<RawClient> {
  return new Promise<RawClient>((resolve, reject) => {
    let isClosed = false;
    const socket = netConnect({ host: '127.0.0.1', port });
    socket.on('close', () => { isClosed = true; });
    // A server-side teardown can surface as ECONNRESET on the client — that
    // is the outcome under test, not a failure, so it must not go unhandled.
    socket.on('error', () => undefined);
    socket.once('connect', () => { resolve({ socket, closed: () => isClosed }); });
    socket.once('error', reject);
  });
}

/** Raw TLS-PSK handshake with an explicit identity — bypasses the agent so
 *  no pooled socket can mask the outcome. */
function tryHandshake(port: number, identity: string, psk: Buffer): Promise<'connected' | 'rejected'> {
  return new Promise((resolve) => {
    const socket = tlsConnect({
      host: '127.0.0.1',
      port,
      ciphers: SHARING_TLS_CIPHERS,
      minVersion: SHARING_TLS_MIN_VERSION,
      maxVersion: SHARING_TLS_MAX_VERSION,
      rejectUnauthorized: false,
      pskCallback: () => ({ psk, identity }),
    });
    socket.once('secureConnect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', () => { socket.destroy(); resolve('rejected'); });
  });
}

describe('sharing listener lifetime and bounds', () => {
  it('(a) auto-stops once after the idle timeout, then refuses new requests', async () => {
    let autoStops = 0;
    const server = await startTestServer({ idleTimeoutMs: 200, onAutoStop: () => { autoStops++; } });
    try {
      expect(server.autoStopAt()).not.toBeNull();
      expect(await eventually(() => autoStops > 0, 600)).toBe(true);
      // Still exactly once, well after it fired.
      await sleep(300);
      expect(autoStops).toBe(1);
      expect(server.autoStopAt()).toBeNull();
      await expect(fetchManifest({ host: '127.0.0.1', port: server.port, psk: PSK })).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  it('never auto-stops without an idle timeout', async () => {
    const server = await startTestServer({});
    try {
      expect(server.autoStopAt()).toBeNull();
      await sleep(50);
      await expect(fetchManifest({ host: '127.0.0.1', port: server.port, psk: PSK })).resolves.toContain('Test Publisher');
    } finally {
      await server.close();
    }
  });

  it('(b) a served request re-arms the timer, and its idle keep-alive socket does not keep the server up', async () => {
    let autoStops = 0;
    let connected = 0;
    const server = await startTestServer({
      idleTimeoutMs: 600,
      onAutoStop: () => { autoStops++; },
      onConnectionsChanged: (n) => { connected = n; },
    });
    try {
      const firstDeadline = server.autoStopAt() ?? 0;
      await sleep(300);
      await fetchManifest({ host: '127.0.0.1', port: server.port, psk: PSK });
      // The response's close re-arms from "now", pushing the deadline back.
      expect(await eventually(() => (server.autoStopAt() ?? 0) > firstDeadline, 500)).toBe(true);
      // Past the ORIGINAL deadline the server is still up.
      await sleep(Math.max(0, firstDeadline + 100 - Date.now()));
      expect(autoStops).toBe(0);
      // The agent left an authenticated keep-alive socket open…
      expect(connected).toBeGreaterThanOrEqual(1);
      // …yet the server still auto-stops on the re-armed deadline, long before
      // Node's 5 s server keep-alive timeout would have reaped that socket.
      expect(await eventually(() => autoStops === 1, 1500)).toBe(true);
      expect(await eventually(() => connected === 0, 500)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('(c) never cuts a transfer that outlasts the idle timeout', async () => {
    let autoStops = 0;
    const server = await startTestServer({ idleTimeoutMs: 200, onAutoStop: () => { autoStops++; } }, 500);
    try {
      const path = 'aws/raw/daily-2026-06/part-0.parquet';
      const buf = await fetchFile({ host: '127.0.0.1', port: server.port, psk: PSK }, path);
      expect(buf.equals(files.get(path) ?? Buffer.alloc(0))).toBe(true);
      expect(autoStops).toBe(0);
      // Once the transfer is done it goes idle and stops as normal.
      expect(await eventually(() => autoStops === 1, 1000)).toBe(true);
    } finally {
      await server.close();
    }
  });

  it('(d) close() resolves promptly with 20 raw unauthenticated sockets open', async () => {
    const server = await startTestServer({});
    const clients: RawClient[] = [];
    try {
      for (let i = 0; i < 20; i++) clients.push(await openRawSocket(server.port));
      // Let the server side accept all of them.
      await sleep(50);
      const outcome = await Promise.race([
        server.close().then(() => 'closed'),
        sleep(1000).then(() => 'timed-out'),
      ]);
      expect(outcome).toBe('closed');
      expect(await eventually(() => clients.every(c => c.closed()), 500)).toBe(true);
    } finally {
      for (const c of clients) c.socket.destroy();
      await server.close();
    }
  });

  it('close() is idempotent', async () => {
    const server = await startTestServer({ idleTimeoutMs: 60_000 });
    await Promise.all([server.close(), server.close()]);
    await server.close();
    expect(server.autoStopAt()).toBeNull();
  });

  it('(e) drops a socket that never completes the TLS handshake', async () => {
    const server = await startTestServer({ handshakeTimeoutMs: 200 });
    const clients: RawClient[] = [];
    try {
      const client = await openRawSocket(server.port);
      clients.push(client);
      expect(client.closed()).toBe(false);
      expect(await eventually(() => client.closed(), 1000)).toBe(true);
    } finally {
      for (const c of clients) c.socket.destroy();
      await server.close();
    }
  });

  it('(f) closes connections beyond maxConnections', async () => {
    const server = await startTestServer({ maxConnections: 4 });
    const clients: RawClient[] = [];
    try {
      for (let i = 0; i < 6; i++) clients.push(await openRawSocket(server.port));
      // The two excess sockets are closed on accept; the first four are held
      // (the handshake timeout is the 10 s default, far beyond this wait).
      expect(await eventually(() => clients.filter(c => c.closed()).length === 2, 1000)).toBe(true);
      await sleep(100);
      expect(clients.filter(c => c.closed())).toHaveLength(2);
      expect(clients.slice(0, 4).every(c => !c.closed())).toBe(true);
    } finally {
      for (const c of clients) c.socket.destroy();
      await server.close();
    }
  });

  it('(g) rejects a handshake presenting the wrong psk identity', async () => {
    // Fresh servers + raw tls.connect: no pooled agent socket can mask it.
    const wrongIdentity = await startTestServer({});
    try {
      expect(await tryHandshake(wrongIdentity.port, 'not-costgoblin', PSK)).toBe('rejected');
    } finally {
      await wrongIdentity.close();
    }
    const rightIdentity = await startTestServer({});
    try {
      expect(await tryHandshake(rightIdentity.port, SHARING_PSK_IDENTITY, PSK)).toBe('connected');
    } finally {
      await rightIdentity.close();
    }
  });
});
