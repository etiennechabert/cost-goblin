import { describe, it, expect } from 'vitest';
import {
  generateIdentityKeyPair,
  isValidPublicKey,
  publicKeyFingerprint,
  signBytes,
  verifyBytes,
} from '../peer/identity.js';
import {
  encodeSharingKey,
  parseSharingKey,
  SharingKeyError,
  SHARING_KEY_VERSION,
  type SharingKeyPayload,
} from '../peer/sharing-key.js';

describe('identity keypair', () => {
  it('generates a 32-byte raw public key and a PEM private key', () => {
    const id = generateIdentityKeyPair();
    expect(isValidPublicKey(id.publicKey)).toBe(true);
    expect(Buffer.from(id.publicKey, 'base64url')).toHaveLength(32);
    expect(id.privateKey).toContain('BEGIN PRIVATE KEY');
  });

  it('signs and verifies a round trip', () => {
    const id = generateIdentityKeyPair();
    const data = Buffer.from('manifest-bytes');
    const sig = signBytes(id.privateKey, data);
    expect(verifyBytes(id.publicKey, data, sig)).toBe(true);
  });

  it('rejects a signature from a different identity', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    const data = Buffer.from('payload');
    const sig = signBytes(a.privateKey, data);
    expect(verifyBytes(b.publicKey, data, sig)).toBe(false);
  });

  it('rejects tampered data', () => {
    const id = generateIdentityKeyPair();
    const sig = signBytes(id.privateKey, Buffer.from('original'));
    expect(verifyBytes(id.publicKey, Buffer.from('tampered'), sig)).toBe(false);
  });

  it('produces a deterministic, formatted fingerprint', () => {
    const id = generateIdentityKeyPair();
    const fp = publicKeyFingerprint(id.publicKey);
    expect(fp).toBe(publicKeyFingerprint(id.publicKey));
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });
});

function validPayload(): SharingKeyPayload {
  const id = generateIdentityKeyPair();
  return {
    v: SHARING_KEY_VERSION,
    hosts: ['192.168.1.42', 'etienne-mbp.local'],
    port: 53170,
    pub: id.publicKey,
    psk: Buffer.alloc(24, 7).toString('base64url'),
    label: "Etienne's CostGoblin",
  };
}

describe('sharing key', () => {
  it('round-trips a valid payload', () => {
    const payload = validPayload();
    const parsed = parseSharingKey(encodeSharingKey(payload));
    expect(parsed).toEqual(payload);
  });

  it('tolerates surrounding whitespace on paste', () => {
    const key = encodeSharingKey(validPayload());
    expect(() => parseSharingKey(`\n  ${key}  \n`)).not.toThrow();
  });

  it('rejects a key without the CostGoblin prefix', () => {
    expect(() => parseSharingKey('not-a-key')).toThrow(SharingKeyError);
  });

  it('rejects a corrupt / truncated key', () => {
    const key = encodeSharingKey(validPayload());
    expect(() => parseSharingKey(key.slice(0, key.length - 10))).toThrow(SharingKeyError);
  });

  it('rejects an unsupported version', () => {
    const payload = { ...validPayload(), v: 99 };
    const encoded = 'CGSHARE1-' + Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(() => parseSharingKey(encoded)).toThrow(/Unsupported sharing key version/);
  });

  it('rejects invalid hosts, ports, keys, secrets, and labels', () => {
    const base = validPayload();
    const variants: SharingKeyPayload[] = [
      { ...base, hosts: [] },
      { ...base, hosts: ['999.1.1.1'] },
      { ...base, hosts: ['evil host;rm -rf'] },
      { ...base, port: 0 },
      { ...base, port: 70000 },
      { ...base, pub: 'too-short' },
      { ...base, psk: Buffer.alloc(4).toString('base64url') },
      { ...base, label: '' },
    ];
    for (const v of variants) {
      expect(() => parseSharingKey(encodeSharingKey(v))).toThrow(SharingKeyError);
    }
  });
});
