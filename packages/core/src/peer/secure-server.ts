import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { isSafePackPath } from './pack-manifest.js';
import {
  SHARING_PSK_IDENTITY,
  SHARING_TLS_CIPHERS,
  SHARING_TLS_MAX_VERSION,
  SHARING_TLS_MIN_VERSION,
} from './tls-psk.js';

export interface SharingServerHandlers {
  /** Returns the serialized SignedPackManifest JSON to advertise. */
  readonly getManifest: () => Promise<string> | string;
  /** Reads a pack file. `path` is already validated as a safe pack path. */
  readonly readFile: (path: string) => Promise<Buffer>;
}

/** Emitted after a request is successfully served, so the publisher can show
 *  who is pulling. Fired only for authenticated (handshake-passed) requests. */
export interface SharingAccessEvent {
  readonly kind: 'manifest' | 'file';
  readonly path: string | null;
  readonly remoteAddress: string | null;
  /** Bytes written for this response — drives served-byte totals + throughput. */
  readonly bytes: number;
}

export interface SharingServerConfig {
  /** Pre-shared access secret. Only a peer holding it can complete the handshake. */
  readonly psk: Buffer;
  /** Interface to bind. Default 0.0.0.0 so LAN peers can reach it. */
  readonly host?: string;
  /** Port to bind. Default 0 (ephemeral) — the chosen port is reported back. */
  readonly port?: number;
  readonly pskIdentity?: string;
  /** Called after each served request, for activity feedback. */
  readonly onAccess?: (event: SharingAccessEvent) => void;
  /** Called whenever the count of authenticated, connected peers changes. */
  readonly onConnectionsChanged?: (count: number) => void;
  /** Stop on our own after this long with no request in flight. Each served
   *  request re-arms it, and a transfer is never cut: a timer that fires
   *  mid-request re-arms instead. Idle keep-alive and pre-handshake sockets
   *  neither hold the server up nor re-arm it. Unset → never auto-stops. */
  readonly idleTimeoutMs?: number;
  /** Called once, after an idle auto-stop has closed the server. */
  readonly onAutoStop?: () => void;
  /** A connection must finish its TLS handshake within this long or it is
   *  dropped. Default 10 s (Node's own default is 120 s). */
  readonly handshakeTimeoutMs?: number;
  /** Cap on concurrent TCP connections, authenticated or not; excess ones
   *  are closed on accept. Default 32. */
  readonly maxConnections?: number;
}

export interface SharingServer {
  readonly port: number;
  /** Stop listening and tear down every socket — authenticated or still
   *  mid-handshake. Idempotent: later calls return the same promise. */
  readonly close: () => Promise<void>;
  /** Epoch ms at which the idle timer would stop the server, or null when no
   *  idle timeout is configured or the server is closed. */
  readonly autoStopAt: () => number | null;
}

/** Node's own default is 120 s, long enough for an unauthenticated LAN host
 *  to pin connection slots (and stall a Stop) just by opening sockets. */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;
/** Concurrent TCP connections, authenticated or not. A pull opens a handful
 *  (the client's agent pools them), so this leaves ample headroom for a
 *  team while bounding descriptor use. */
const DEFAULT_MAX_CONNECTIONS = 32;

interface IdleTracker {
  readonly requestStarted: () => void;
  readonly requestEnded: () => void;
  readonly arm: () => void;
  readonly deadline: () => number | null;
  readonly cancel: () => void;
}

/** Idle auto-stop bookkeeping, keyed on in-flight REQUESTS rather than open
 *  sockets: an idle keep-alive socket or a half-open handshake never holds
 *  the server up. Every finished request re-arms the full timeout; a timer
 *  that lands while a request is in flight re-arms instead of firing, so a
 *  long transfer is never cut. With no timeout configured it is inert. */
function createIdleTracker(timeoutMs: number | undefined, onIdle: () => void): IdleTracker {
  let inFlight = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadlineMs: number | null = null;
  let cancelled = false;
  const clear = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const arm = (): void => {
    if (timeoutMs === undefined || cancelled) return;
    clear();
    deadlineMs = Date.now() + timeoutMs;
    timer = setTimeout(() => {
      timer = null;
      if (inFlight > 0) { arm(); return; }
      onIdle();
    }, timeoutMs);
    // Never keep the process alive just to stop a server.
    timer.unref();
  };
  return {
    requestStarted: () => { inFlight++; },
    requestEnded: () => { inFlight = Math.max(0, inFlight - 1); arm(); },
    arm,
    deadline: () => (cancelled ? null : deadlineMs),
    cancel: () => {
      cancelled = true;
      clear();
      deadlineMs = null;
    },
  };
}

/** Start a TLS-PSK HTTP server exposing GET /manifest and GET /file?path=…
 *  The TLS handshake is the access gate (no psk → no connection); content is
 *  additionally Ed25519-signed in the manifest, so the channel encrypts and
 *  the payload is independently tamper-evident. */
export async function startSharingServer(
  config: SharingServerConfig,
  handlers: SharingServerHandlers,
): Promise<SharingServer> {
  const identity = config.pskIdentity ?? SHARING_PSK_IDENTITY;
  // Assigned below; the idle tracker only calls it after listen().
  let closeServer: () => Promise<void> = () => Promise.resolve();
  let autoStopped = false;
  const idle = createIdleTracker(config.idleTimeoutMs, () => {
    void closeServer().then(() => {
      if (autoStopped) return;
      autoStopped = true;
      config.onAutoStop?.();
    });
  });

  const server: Server = createServer(
    {
      ciphers: SHARING_TLS_CIPHERS,
      minVersion: SHARING_TLS_MIN_VERSION,
      maxVersion: SHARING_TLS_MAX_VERSION,
      handshakeTimeout: config.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      pskCallback: (_socket, id) => (id === identity ? config.psk : null),
    },
    (req, res) => {
      idle.requestStarted();
      // 'close' fires once per response — finished, errored or aborted — so
      // the in-flight count can never leak and wedge the server up.
      res.once('close', () => { idle.requestEnded(); });
      const remoteAddress = req.socket.remoteAddress ?? null;
      const report = (kind: 'manifest' | 'file', path: string | null, bytes: number): void => {
        config.onAccess?.({ kind, path, remoteAddress, bytes });
      };
      void handleRequest(req, res, handlers, report);
    },
  );
  server.maxConnections = config.maxConnections ?? DEFAULT_MAX_CONNECTIONS;

  // Every accepted TCP socket, including ones still mid-handshake (or that
  // never start one). server.close() waits for all of them, so without
  // destroying these a single silent LAN host stalls Stop/Rotate until its
  // handshake times out.
  const rawSockets = new Set<Socket>();
  server.on('connection', (socket: Socket) => {
    rawSockets.add(socket);
    socket.once('close', () => { rawSockets.delete(socket); });
  });

  // Authenticated peer sockets, for the live connected count (and destroyed
  // on stop alongside the raw ones — server.close() alone would wait for
  // keep-alive sockets to idle out).
  const secureSockets = new Set<TLSSocket>();
  server.on('secureConnection', (socket: TLSSocket) => {
    secureSockets.add(socket);
    config.onConnectionsChanged?.(secureSockets.size);
    socket.on('close', () => {
      secureSockets.delete(socket);
      config.onConnectionsChanged?.(secureSockets.size);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => { reject(err); };
    server.once('error', onError);
    server.listen(config.port ?? 0, config.host ?? '0.0.0.0', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  let closing: Promise<void> | null = null;
  closeServer = () => {
    if (closing !== null) return closing;
    idle.cancel();
    closing = new Promise<void>((resolve) => {
      server.close(() => { resolve(); });
      for (const socket of secureSockets) socket.destroy();
      for (const socket of rawSockets) socket.destroy();
    });
    return closing;
  };
  idle.arm();

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => closeServer(),
    autoStopAt: () => idle.deadline(),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: SharingServerHandlers,
  report: (kind: 'manifest' | 'file', path: string | null, bytes: number) => void,
): Promise<void> {
  try {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url ?? '/', 'https://peer.local');

    if (url.pathname === '/manifest') {
      const body = await handlers.getManifest();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      report('manifest', null, Buffer.byteLength(body));
      return;
    }

    if (url.pathname === '/file') {
      const path = url.searchParams.get('path');
      if (path === null || !isSafePackPath(path)) { res.writeHead(400); res.end(); return; }
      const file = await handlers.readFile(path);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(file.length) });
      res.end(file);
      report('file', path, file.length);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}
