import { describe, it, expect } from 'vitest';
import { generateIdentityKeyPair } from '../peer/identity.js';
import {
  isSafePackPath,
  parseSignedManifest,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  verifyManifestSignature,
  PackManifestError,
  PACK_MANIFEST_VERSION,
  type PackManifest,
} from '../peer/pack-manifest.js';

function fixtureManifest(publisher: string): PackManifest {
  return {
    v: PACK_MANIFEST_VERSION,
    createdAt: '2026-06-21T00:00:00.000Z',
    publisher,
    label: "Etienne's CostGoblin",
    configBundle: 'kind: costgoblin-config-bundle\n',
    enrichment: { orgAccounts: '{"accounts":[]}', regionNames: null, orgAccountTags: null },
    files: [
      { path: 'aws/raw/daily-2026-06/part-0.parquet', size: 1024, sha256: sha256Hex(Buffer.from('a')) },
      { path: 'aws/raw/daily-2026-06/part-1.parquet', size: 2048, sha256: sha256Hex(Buffer.from('b')) },
    ],
  };
}

describe('sha256Hex', () => {
  it('hashes deterministically', () => {
    expect(sha256Hex(Buffer.from('x'))).toBe(sha256Hex(Buffer.from('x')));
    expect(sha256Hex(Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isSafePackPath', () => {
  it('accepts data-tree parquet paths', () => {
    expect(isSafePackPath('aws/raw/daily-2026-06/part-0.parquet')).toBe(true);
    expect(isSafePackPath('aws/raw/cost-opt-2026-06-08/part.parquet')).toBe(true);
  });
  it('rejects traversal and out-of-tree paths', () => {
    for (const p of [
      '../../etc/passwd',
      '/etc/passwd',
      'aws/raw/daily-2026-06/../../x.parquet',
      'aws/raw/daily-2026-06/file.txt',
      'config/dimensions.yaml',
      'aws/raw/daily-2026-06/sub/dir/x.parquet',
    ]) {
      expect(isSafePackPath(p)).toBe(false);
    }
  });
});

describe('signed pack manifest', () => {
  it('signs, serializes, parses, and verifies a round trip', () => {
    const id = generateIdentityKeyPair();
    const signed = signManifest(fixtureManifest(id.publicKey), id.privateKey);
    const parsed = parseSignedManifest(serializeSignedManifest(signed));
    expect(parsed.manifest).toEqual(signed.manifest);
    expect(verifyManifestSignature(parsed)).toBe(true);
  });

  it('fails verification when the manifest is tampered after signing', () => {
    const id = generateIdentityKeyPair();
    const signed = signManifest(fixtureManifest(id.publicKey), id.privateKey);
    const tampered = { ...signed, manifest: { ...signed.manifest, label: 'Evil' } };
    expect(verifyManifestSignature(tampered)).toBe(false);
  });

  it('fails verification when signed by a different identity', () => {
    const publisher = generateIdentityKeyPair();
    const attacker = generateIdentityKeyPair();
    // Attacker signs a manifest that claims the publisher's key.
    const forged = signManifest(fixtureManifest(publisher.publicKey), attacker.privateKey);
    expect(verifyManifestSignature(forged)).toBe(false);
  });

  it('rejects a manifest whose file path escapes the data tree', () => {
    const id = generateIdentityKeyPair();
    const m = fixtureManifest(id.publicKey);
    const evil: PackManifest = {
      ...m,
      files: [{ path: '../../../etc/cron.d/x.parquet', size: 1, sha256: sha256Hex(Buffer.from('c')) }],
    };
    const signed = signManifest(evil, id.privateKey);
    expect(() => parseSignedManifest(serializeSignedManifest(signed))).toThrow(PackManifestError);
  });

  it('rejects malformed JSON and missing signature', () => {
    expect(() => parseSignedManifest('not json')).toThrow(PackManifestError);
    expect(() => parseSignedManifest(JSON.stringify({ manifest: {} }))).toThrow(PackManifestError);
  });
});
