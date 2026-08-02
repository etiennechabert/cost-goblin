import { describe, it, expect } from 'vitest';
import { generateIdentityKeyPair } from '../peer/identity.js';
import {
  classifyPackPath,
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
  it('accepts any valid provider-name segment, not just aws', () => {
    expect(isSafePackPath('aws-main/raw/daily-2026-06/part-0.parquet')).toBe(true);
    expect(isSafePackPath('prod_2/raw/hourly-2026-05/part-1.parquet')).toBe(true);
  });
  it('rejects traversal and out-of-tree paths', () => {
    for (const p of [
      '../../etc/passwd',
      '/etc/passwd',
      'aws/raw/daily-2026-06/../../x.parquet',
      'aws/raw/daily-2026-06/file.txt',
      'config/dimensions.yaml',
      'aws/raw/daily-2026-06/sub/dir/x.parquet',
      '.hidden/raw/daily-2026-06/x.parquet',
      'aws.prod/raw/daily-2026-06/x.parquet',
    ]) {
      expect(isSafePackPath(p)).toBe(false);
    }
  });
});

describe('classifyPackPath', () => {
  it('classifies daily and hourly paths by their tier prefix', () => {
    expect(classifyPackPath('aws/raw/daily-2026-06/part-0.parquet')).toEqual({ provider: 'aws', tier: 'daily', period: '2026-06' });
    expect(classifyPackPath('aws/raw/hourly-2026-05/part-1.parquet')).toEqual({ provider: 'aws', tier: 'hourly', period: '2026-05' });
  });

  it('returns the provider segment for non-aws provider names', () => {
    expect(classifyPackPath('aws-main/raw/daily-2026-06/part-0.parquet')).toEqual({ provider: 'aws-main', tier: 'daily', period: '2026-06' });
  });

  it('maps the cost-opt directory prefix to the cost-optimization tier and a YYYY-MM period', () => {
    // cost-opt directories carry a -DD day suffix; the period is still the month.
    expect(classifyPackPath('aws/raw/cost-opt-2026-04-08/r.parquet')).toEqual({ provider: 'aws', tier: 'cost-optimization', period: '2026-04' });
  });

  it('returns null for unknown prefixes and non-pack paths', () => {
    expect(classifyPackPath('aws/raw/weekly-2026-06/x.parquet')).toBeNull();
    expect(classifyPackPath('config/dimensions.yaml')).toBeNull();
    expect(classifyPackPath('../../etc/passwd')).toBeNull();
  });
});

describe('signed pack manifest', () => {
  it('publishes new packs at manifest version 2', () => {
    expect(PACK_MANIFEST_VERSION).toBe(2);
  });

  it('signs, serializes, parses, and verifies a round trip', () => {
    const id = generateIdentityKeyPair();
    const signed = signManifest(fixtureManifest(id.publicKey), id.privateKey);
    const parsed = parseSignedManifest(serializeSignedManifest(signed));
    expect(parsed.manifest).toEqual(signed.manifest);
    expect(verifyManifestSignature(parsed)).toBe(true);
  });

  it('still accepts a v1 manifest and preserves its version so the signature verifies', () => {
    const id = generateIdentityKeyPair();
    const v1: PackManifest = { ...fixtureManifest(id.publicKey), v: 1 };
    const signed = signManifest(v1, id.privateKey);
    const parsed = parseSignedManifest(serializeSignedManifest(signed));
    // `v` must round-trip verbatim — rewriting it to 2 would break the
    // signature, which covers the exact bytes the publisher signed.
    expect(parsed.manifest.v).toBe(1);
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
