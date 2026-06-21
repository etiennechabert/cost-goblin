import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
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
      const report = (kind: 'manifest' | 'file', path: string | null): void => {
        config.onAccess?.({ kind, path, remoteAddress });
      };
      void handleRequest(req, res, handlers, report);
    },
  );

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
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve(); }); }),
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  handlers: SharingServerHandlers,
  report: (kind: 'manifest' | 'file', path: string | null) => void,
): Promise<void> {
  try {
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    const url = new URL(req.url ?? '/', 'https://peer.local');

    if (url.pathname === '/manifest') {
      const body = await handlers.getManifest();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
      report('manifest', null);
      return;
    }

    if (url.pathname === '/file') {
      const path = url.searchParams.get('path');
      if (path === null || !isSafePackPath(path)) { res.writeHead(400); res.end(); return; }
      const file = await handlers.readFile(path);
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(file.length) });
      res.end(file);
      report('file', path);
      return;
    }

    res.writeHead(404);
    res.end();
  } catch {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}
