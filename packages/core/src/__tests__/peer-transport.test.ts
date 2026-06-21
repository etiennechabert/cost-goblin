import { describe, it, expect } from 'vitest';
import { generateIdentityKeyPair } from '../peer/identity.js';
import {
  parseSignedManifest,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  verifyManifestSignature,
  type PackManifest,
} from '../peer/pack-manifest.js';
import { startSharingServer } from '../peer/secure-server.js';
import { fetchFile, fetchManifest } from '../peer/secure-client.js';

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

    const server = await startSharingServer(
      { psk, host: '127.0.0.1' },
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
