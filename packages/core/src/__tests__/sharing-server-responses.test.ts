import { describe, it, expect } from 'vitest';
import { request, type RequestOptions } from 'node:https';
import type { ConnectionOptions } from 'node:tls';
import {
  startSharingServer,
  type SharingAccessEvent,
  type SharingServer,
  type SharingServerConfig,
  type SharingServerHandlers,
} from '../peer/secure-server.js';
import { fetchFile, fetchManifest, type PeerEndpoint } from '../peer/secure-client.js';
import {
  SHARING_PSK_IDENTITY,
  SHARING_TLS_CIPHERS,
  SHARING_TLS_MAX_VERSION,
  SHARING_TLS_MIN_VERSION,
} from '../peer/tls-psk.js';

/**
 * What the sharing listener answers to an authenticated peer that asks for
 * something other than a manifest or a safe pack file, or whose request the
 * publisher fails to serve. Every server binds 127.0.0.1 on an ephemeral port
 * and is closed (which destroys its sockets) before the test ends.
 */

const PSK = Buffer.from('shared-access-secret-0123456789ab');
const MANIFEST_BODY = '{"manifest":"stub","signature":"stub"}';
const FILE_PATH = 'aws/raw/daily-2026-06/part-0.parquet';
const FILE_BYTES = Buffer.from('parquet-bytes');

interface Recorder {
  manifestCalls: number;
  readonly fileReads: string[];
  readonly accesses: SharingAccessEvent[];
}

function recorder(): Recorder {
  return { manifestCalls: 0, fileReads: [], accesses: [] };
}

function recordingHandlers(rec: Recorder): SharingServerHandlers {
  return {
    getManifest: () => {
      rec.manifestCalls++;
      return MANIFEST_BODY;
    },
    readFile: (path) => {
      rec.fileReads.push(path);
      return Promise.resolve(FILE_BYTES);
    },
  };
}

async function withServer(
  handlers: SharingServerHandlers,
  extra: Omit<SharingServerConfig, 'psk' | 'host'>,
  body: (server: SharingServer, endpoint: PeerEndpoint) => Promise<void>,
): Promise<void> {
  const server = await startSharingServer({ psk: PSK, host: '127.0.0.1', ...extra }, handlers);
  try {
    await body(server, { host: '127.0.0.1', port: server.port, psk: PSK });
  } finally {
    await server.close();
  }
}

interface RawResponse {
  readonly status: number;
  readonly body: string;
}

/** One authenticated request with any method and path, on a fresh socket
 *  (no agent pooling), returning the status and body as sent. */
function send(port: number, method: string, path: string): Promise<RawResponse> {
  const options: RequestOptions & ConnectionOptions = {
    host: '127.0.0.1',
    port,
    method,
    path,
    agent: false,
    ciphers: SHARING_TLS_CIPHERS,
    minVersion: SHARING_TLS_MIN_VERSION,
    maxVersion: SHARING_TLS_MAX_VERSION,
    rejectUnauthorized: false,
    pskCallback: () => ({ psk: PSK, identity: SHARING_PSK_IDENTITY }),
  };
  return new Promise<RawResponse>((resolve, reject) => {
    const req = request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }); });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

describe('sharing server: requests it does not serve', () => {
  it('answers 405 to any method but GET, without building the manifest', async () => {
    const rec = recorder();
    await withServer(recordingHandlers(rec), { onAccess: (e) => rec.accesses.push(e) }, async (server) => {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        expect(await send(server.port, method, '/manifest')).toEqual({ status: 405, body: '' });
      }
      expect(await send(server.port, 'POST', `/file?path=${encodeURIComponent(FILE_PATH)}`)).toEqual({ status: 405, body: '' });
      // A GET on the same server still works.
      expect(await send(server.port, 'GET', '/manifest')).toEqual({ status: 200, body: MANIFEST_BODY });
    });
    expect(rec.manifestCalls).toBe(1);
    expect(rec.fileReads).toEqual([]);
    expect(rec.accesses.map(a => a.kind)).toEqual(['manifest']);
  });

  it('answers 404 to an unknown path', async () => {
    const rec = recorder();
    await withServer(recordingHandlers(rec), { onAccess: (e) => rec.accesses.push(e) }, async (server) => {
      for (const path of ['/', '/files', '/manifest/extra', `/raw/${FILE_PATH}`]) {
        expect(await send(server.port, 'GET', path)).toEqual({ status: 404, body: '' });
      }
    });
    expect(rec.manifestCalls).toBe(0);
    expect(rec.fileReads).toEqual([]);
    expect(rec.accesses).toEqual([]);
  });

  it('answers 400 to a file request without a safe pack path, and reads nothing', async () => {
    const rec = recorder();
    await withServer(recordingHandlers(rec), {}, async (server) => {
      for (const query of ['', '?path=', '?other=x', '?path=..%2F..%2Fetc%2Fpasswd', '?path=config%2Fdimensions.yaml']) {
        expect(await send(server.port, 'GET', `/file${query}`)).toEqual({ status: 400, body: '' });
      }
    });
    expect(rec.fileReads).toEqual([]);
  });
});

describe('sharing server: failures while serving', () => {
  it('answers 500 when the manifest cannot be built, reports no access, and keeps serving', async () => {
    const accesses: SharingAccessEvent[] = [];
    let calls = 0;
    const handlers: SharingServerHandlers = {
      getManifest: () => {
        calls++;
        if (calls === 1) throw new Error('manifest build failed');
        return MANIFEST_BODY;
      },
      readFile: () => Promise.resolve(FILE_BYTES),
    };
    await withServer(handlers, { onAccess: (e) => accesses.push(e) }, async (_server, endpoint) => {
      await expect(fetchManifest(endpoint)).rejects.toThrow('Peer responded 500 for /manifest');
      expect(accesses).toEqual([]);
      await expect(fetchManifest(endpoint)).resolves.toBe(MANIFEST_BODY);
    });
    expect(calls).toBe(2);
    expect(accesses.map(a => a.kind)).toEqual(['manifest']);
  });

  it('answers 500 when a file cannot be read, and reports no access for it', async () => {
    const accesses: SharingAccessEvent[] = [];
    const reads: string[] = [];
    const handlers: SharingServerHandlers = {
      getManifest: () => MANIFEST_BODY,
      readFile: (path) => {
        reads.push(path);
        return Promise.reject(new Error('EACCES'));
      },
    };
    await withServer(handlers, { onAccess: (e) => accesses.push(e) }, async (_server, endpoint) => {
      await expect(fetchFile(endpoint, FILE_PATH)).rejects.toThrow(/Peer responded 500/);
    });
    expect(reads).toEqual([FILE_PATH]);
    expect(accesses).toEqual([]);
  });

  it('still delivers the response when the access observer throws', async () => {
    const seen: SharingAccessEvent[] = [];
    const onAccess = (e: SharingAccessEvent): void => {
      seen.push(e);
      throw new Error('observer failed');
    };
    await withServer(recordingHandlers(recorder()), { onAccess }, async (_server, endpoint) => {
      // The observer runs after the response is written; its failure must
      // neither turn the reply into an error nor take the server down.
      await expect(fetchManifest(endpoint)).resolves.toBe(MANIFEST_BODY);
      expect(await fetchFile(endpoint, FILE_PATH)).toEqual(FILE_BYTES);
      await expect(fetchManifest(endpoint)).resolves.toBe(MANIFEST_BODY);
    });
    expect(seen.map(e => ({ kind: e.kind, path: e.path, bytes: e.bytes }))).toEqual([
      { kind: 'manifest', path: null, bytes: Buffer.byteLength(MANIFEST_BODY) },
      { kind: 'file', path: FILE_PATH, bytes: FILE_BYTES.length },
      { kind: 'manifest', path: null, bytes: Buffer.byteLength(MANIFEST_BODY) },
    ]);
    expect(seen.every(e => e.remoteAddress === '127.0.0.1')).toBe(true);
  });
});

describe('sharing server: startup', () => {
  it('refuses an out-of-range port before binding anything', async () => {
    // No host given, so the all-interfaces default is chosen — but the port
    // is validated before any bind is attempted, so nothing ever listens.
    const attempt = startSharingServer({ psk: PSK, port: 65_536 }, recordingHandlers(recorder()));
    await expect(attempt).rejects.toThrow(RangeError);
    await expect(attempt).rejects.toHaveProperty('code', 'ERR_SOCKET_BAD_PORT');
  });
});
