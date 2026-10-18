import type { IncomingMessage } from 'node:http';
import { request, type RequestOptions } from 'node:https';
import { connect as tlsConnect, type ConnectionOptions } from 'node:tls';
import { firstReachable } from './first-reachable.js';
import { isConfigFileName, MANIFEST_UNAVAILABLE_STATUS } from './manifest-unavailable.js';
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
/** A MANIFEST_UNAVAILABLE_STATUS body is a config file's name: anything past
 *  this is not one, and isn't buffered. */
const MAX_ERROR_BODY_BYTES = 256;
/** A host that hasn't finished the TLS handshake by then isn't coming: off its
 *  own network an address swallows the connection instead of refusing it, so
 *  without this each dead address of a sharing key stalled the full
 *  REQUEST_TIMEOUT_MS. Matches the server's own handshake deadline. */
const CONNECT_TIMEOUT_MS = 10_000;

export interface PeerRequestOptions {
  /** Deadline for the TCP connect + TLS handshake of a new socket. A socket
   *  reused from the agent's keep-alive pool is already past it. */
  readonly connectTimeoutMs?: number;
}

export interface PeerProbeOptions extends PeerRequestOptions {
  /** Hangs up — e.g. once another address of the key answered. */
  readonly signal?: AbortSignal;
}

/** The peer answered with an error status. `body` is the text of a
 *  MANIFEST_UNAVAILABLE_STATUS answer (meant to be a config file's name, but
 *  unchecked), null for any other status. */
export class PeerResponseError extends Error {
  readonly status: number;
  readonly body: string | null;

  constructor(status: number, path: string, body: string | null) {
    super(`Peer responded ${String(status)} for ${path}`);
    this.name = 'PeerResponseError';
    this.status = status;
    this.body = body;
  }
}

/** Up to MAX_ERROR_BODY_BYTES of a response's text; the rest is drained. */
function readErrorBody(res: IncomingMessage, done: (text: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  res.on('data', (chunk: Buffer) => {
    if (size > MAX_ERROR_BODY_BYTES) return;
    chunks.push(chunk);
    size += chunk.length;
  });
  res.on('end', () => { done(Buffer.concat(chunks).subarray(0, MAX_ERROR_BODY_BYTES + 1).toString('utf-8')); });
}

function connectTimeoutError(connectTimeoutMs: number): Error {
  return new Error(`Peer did not answer within ${String(connectTimeoutMs / 1000)} s`);
}

function tlsOptions(endpoint: PeerEndpoint): ConnectionOptions {
  return {
    host: endpoint.host,
    port: endpoint.port,
    ciphers: SHARING_TLS_CIPHERS,
    minVersion: SHARING_TLS_MIN_VERSION,
    maxVersion: SHARING_TLS_MAX_VERSION,
    // No certificate is in play — PSK provides mutual authentication, and the
    // manifest signature pins the publisher independently.
    rejectUnauthorized: false,
    pskCallback: () => ({ psk: endpoint.psk, identity: endpoint.pskIdentity ?? SHARING_PSK_IDENTITY }),
  };
}

function requestOptions(endpoint: PeerEndpoint, path: string): RequestOptions & ConnectionOptions {
  return { ...tlsOptions(endpoint), path, method: 'GET' };
}

function get(endpoint: PeerEndpoint, path: string, maxBytes: number, options: PeerRequestOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    // Settle exactly once: aborting the request emits further 'error' events on
    // both req and res, which we absorb here rather than leaving unhandled.
    let settled = false;
    const fail = (err: Error): void => { if (!settled) { settled = true; reject(err); } };
    const succeed = (buf: Buffer): void => { if (!settled) { settled = true; resolve(buf); } };
    const req = request(requestOptions(endpoint, path), (res) => {
      res.on('error', fail);
      const status = res.statusCode ?? 0;
      if (status === MANIFEST_UNAVAILABLE_STATUS) {
        readErrorBody(res, (body) => { fail(new PeerResponseError(status, path, body)); });
        return;
      }
      if (status !== 200) {
        res.resume();
        fail(new PeerResponseError(status, path, null));
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
    });
    req.on('error', fail);
    req.on('socket', (socket) => {
      if (req.reusedSocket) return;
      const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        fail(connectTimeoutError(connectTimeoutMs));
        req.destroy();
      }, connectTimeoutMs);
      socket.once('secureConnect', () => { clearTimeout(timer); });
      socket.once('close', () => { clearTimeout(timer); });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => { fail(new Error('Peer request timed out')); req.destroy(); });
    req.end();
  });
}

/** Resolve once a TLS-PSK handshake with `endpoint` completes, then hang up.
 *  A completed handshake proves the address routes to a holder of the psk
 *  (each side's Finished is keyed from it), and no request is sent, so the
 *  publisher builds and serves nothing. */
export function probeEndpoint(endpoint: PeerEndpoint, options: PeerProbeOptions = {}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const { signal } = options;
    const connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
    const socket = tlsConnect(tlsOptions(endpoint));
    let settled = false;
    const finish = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err === null) {
        socket.end();
        resolve();
      } else {
        socket.destroy();
        reject(err);
      }
    };
    const onAbort = (): void => { finish(new Error('Peer probe aborted')); };
    const timer = setTimeout(() => { finish(connectTimeoutError(connectTimeoutMs)); }, connectTimeoutMs);
    socket.once('secureConnect', () => { finish(null); });
    // Kept for the socket's lifetime: a late error must not go unhandled.
    socket.on('error', (err) => { finish(err); });
    if (signal?.aborted === true) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type ManifestFromAnyResult =
  | { readonly status: 'reached'; readonly endpoint: PeerEndpoint; readonly manifest: string }
  /** The publisher answered but can't build its manifest: `file` (its bare
   *  name, null when it sent none) doesn't load there. */
  | { readonly status: 'unavailable'; readonly file: string | null }
  | { readonly status: 'unreachable'; readonly errors: readonly unknown[] };

/** Fetch the manifest through whichever of a sharing key's addresses answers
 *  first. Only handshakes are raced (see firstReachable): requesting the
 *  manifest on every address that routes — LAN and Tailscale both do in the
 *  office — would have the publisher read and hash its whole data tree once
 *  per address. The manifest is then fetched once, from the winner. */
export async function fetchManifestFromAny(
  endpoints: readonly PeerEndpoint[],
  options: PeerRequestOptions = {},
): Promise<ManifestFromAnyResult> {
  const reached = await firstReachable(endpoints, (endpoint, signal) => probeEndpoint(endpoint, { ...options, signal }));
  if (reached.status === 'unreachable') return reached;
  try {
    return { status: 'reached', endpoint: reached.candidate, manifest: await fetchManifest(reached.candidate, options) };
  } catch (err: unknown) {
    if (err instanceof PeerResponseError && err.body !== null) {
      // Shown to the user: only ever a bare file name from the publisher.
      return { status: 'unavailable', file: isConfigFileName(err.body) ? err.body : null };
    }
    return { status: 'unreachable', errors: [err] };
  }
}

/** Fetch the publisher's serialized SignedPackManifest. The caller must parse
 *  it, verify the signature, and check the publisher key is the pinned one. */
export function fetchManifest(endpoint: PeerEndpoint, options: PeerRequestOptions = {}): Promise<string> {
  return get(endpoint, '/manifest', MAX_MANIFEST_BYTES, options).then((buf) => buf.toString('utf-8'));
}

/** Fetch one data file by its safe pack path. Verify its SHA-256 before use.
 *  `maxBytes` (the manifest's advertised size) caps the in-memory buffer so a
 *  publisher can't stream far more than it claimed; it is clamped to the
 *  absolute MAX_FILE_BYTES ceiling regardless. */
export function fetchFile(
  endpoint: PeerEndpoint,
  path: string,
  maxBytes = MAX_FILE_BYTES,
  options: PeerRequestOptions = {},
): Promise<Buffer> {
  return get(endpoint, `/file?path=${encodeURIComponent(path)}`, Math.min(maxBytes, MAX_FILE_BYTES), options);
}
