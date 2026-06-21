import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
}

export interface SharingServer {
  readonly port: number;
  readonly close: () => Promise<void>;
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
  const server: Server = createServer(
    {
      ciphers: SHARING_TLS_CIPHERS,
      minVersion: SHARING_TLS_MIN_VERSION,
      maxVersion: SHARING_TLS_MAX_VERSION,
      pskCallback: (_socket, id) => (id === identity ? config.psk : null),
    },
    (req, res) => {
      const remoteAddress = req.socket.remoteAddress ?? null;
      const report = (kind: 'manifest' | 'file', path: string | null, bytes: number): void => {
        config.onAccess?.({ kind, path, remoteAddress, bytes });
      };
      void handleRequest(req, res, handlers, report);
    },
  );

  // Track authenticated peer sockets so we can report a live connected count
  // and force-close them on stop (server.close() alone waits for keep-alive
  // sockets to idle out, which would make "Stop sharing" appear to hang).
  const sockets = new Set<TLSSocket>();
  server.on('secureConnection', (socket: TLSSocket) => {
    sockets.add(socket);
    config.onConnectionsChanged?.(sockets.size);
    socket.on('close', () => {
      sockets.delete(socket);
      config.onConnectionsChanged?.(sockets.size);
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

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    close: () => new Promise<void>((resolve) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => { resolve(); });
    }),
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
