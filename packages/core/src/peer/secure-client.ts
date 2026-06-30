import { request, type RequestOptions } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import {
  SHARING_PSK_IDENTITY,
  SHARING_TLS_CIPHERS,
  SHARING_TLS_MAX_VERSION,
  SHARING_TLS_MIN_VERSION,
} from './tls-psk.js';

export interface PeerEndpoint {
  readonly host: string;
  readonly port: number;
  readonly psk: Buffer;
  readonly pskIdentity?: string;
}

/** Manifests carry config + enrichment inline but are still small. */
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** A single Parquet partition. Buffered in memory for now; streaming straight
 *  to disk is the eventual optimization for very large monthly files. */
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

function requestOptions(endpoint: PeerEndpoint, path: string): RequestOptions & ConnectionOptions {
  return {
    host: endpoint.host,
    port: endpoint.port,
    path,
    method: 'GET',
    ciphers: SHARING_TLS_CIPHERS,
    minVersion: SHARING_TLS_MIN_VERSION,
    maxVersion: SHARING_TLS_MAX_VERSION,
    // No certificate is in play — PSK provides mutual authentication, and the
    // manifest signature pins the publisher independently.
    rejectUnauthorized: false,
    pskCallback: () => ({ psk: endpoint.psk, identity: endpoint.pskIdentity ?? SHARING_PSK_IDENTITY }),
  };
}

function get(endpoint: PeerEndpoint, path: string, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Settle exactly once: aborting the request emits further 'error' events on
    // both req and res, which we absorb here rather than leaving unhandled.
    let settled = false;
    const fail = (err: Error): void => { if (!settled) { settled = true; reject(err); } };
    const succeed = (buf: Buffer): void => { if (!settled) { settled = true; resolve(buf); } };
    const req = request(requestOptions(endpoint, path), (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`Peer responded ${String(res.statusCode)} for ${path}`));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBytes) {
          fail(new Error('Peer response exceeded the size limit'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => { succeed(Buffer.concat(chunks)); });
      res.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { fail(new Error('Peer request timed out')); req.destroy(); });
    req.end();
  });
}

/** Fetch the publisher's serialized SignedPackManifest. The caller must parse
 *  it, verify the signature, and check the publisher key is the pinned one. */
export function fetchManifest(endpoint: PeerEndpoint): Promise<string> {
  return get(endpoint, '/manifest', MAX_MANIFEST_BYTES).then((buf) => buf.toString('utf-8'));
}

/** Fetch one data file by its safe pack path. Verify its SHA-256 before use.
 *  `maxBytes` (the manifest's advertised size) caps the in-memory buffer so a
 *  publisher can't stream far more than it claimed; it is clamped to the
 *  absolute MAX_FILE_BYTES ceiling regardless. */
export function fetchFile(endpoint: PeerEndpoint, path: string, maxBytes = MAX_FILE_BYTES): Promise<Buffer> {
  return get(endpoint, `/file?path=${encodeURIComponent(path)}`, Math.min(maxBytes, MAX_FILE_BYTES));
}
