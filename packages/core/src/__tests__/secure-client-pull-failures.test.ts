import { describe, it, expect } from 'vitest';
import { fetchManifestFromAny, probeEndpoint, type PeerEndpoint } from '../peer/secure-client.js';
import { startSharingServer, type SharingServer, type SharingServerHandlers } from '../peer/secure-server.js';

/**
 * Pull-side failures that happen after an address was chosen: a probe the
 * caller cancelled before it began, and a publisher that completes the
 * handshake but cannot serve its manifest. Servers bind 127.0.0.1 on an
 * ephemeral port and are always closed.
 */

const PSK = Buffer.from('shared-access-secret-0123456789ab');
const MANIFEST_BODY = '{"manifest":"stub","signature":"stub"}';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}

async function withServer(
  handlers: SharingServerHandlers,
  onConnectionsChanged: (count: number) => void,
  body: (endpoint: PeerEndpoint, server: SharingServer) => Promise<void>,
): Promise<void> {
  const server = await startSharingServer({ psk: PSK, host: '127.0.0.1', onConnectionsChanged }, handlers);
  try {
    await body({ host: '127.0.0.1', port: server.port, psk: PSK }, server);
  } finally {
    await server.close();
  }
}

describe('probeEndpoint with a signal that is already aborted', () => {
  it('rejects at once and never completes a handshake', async () => {
    const counts: number[] = [];
    let manifestCalls = 0;
    const handlers: SharingServerHandlers = {
      getManifest: () => { manifestCalls++; return MANIFEST_BODY; },
      readFile: () => Promise.resolve(Buffer.alloc(0)),
    };
    await withServer(handlers, (n) => counts.push(n), async (endpoint) => {
      const started = Date.now();
      await expect(probeEndpoint(endpoint, { signal: AbortSignal.abort(), connectTimeoutMs: 5_000 }))
        .rejects.toThrow('Peer probe aborted');
      expect(Date.now() - started).toBeLessThan(1_000);
      // Give a stray connection time to show up, were one made.
      await sleep(100);
    });
    expect(counts).toEqual([]);
    expect(manifestCalls).toBe(0);
  });
});

describe('fetchManifestFromAny when the reached publisher cannot serve', () => {
  it('reports the address unreachable with the manifest failure', async () => {
    const handlers: SharingServerHandlers = {
      getManifest: () => { throw new Error('manifest build failed'); },
      readFile: () => Promise.resolve(Buffer.alloc(0)),
    };
    await withServer(handlers, () => undefined, async (endpoint) => {
      const result = await fetchManifestFromAny([endpoint]);
      expect(result.status).toBe('unreachable');
      if (result.status !== 'unreachable') return;
      expect(result.errors).toHaveLength(1);
      // A bare 500 carries no body: only a config file that doesn't load is
      // named to the peer (ManifestUnavailableError).
      expect(result.errors[0]).toMatchObject({ message: 'Peer responded 500 for /manifest', status: 500, body: null });
    });
  });

  it('reports an empty address list as unreachable without dialling anything', async () => {
    await expect(fetchManifestFromAny([])).resolves.toEqual({ status: 'unreachable', errors: [] });
  });
});
