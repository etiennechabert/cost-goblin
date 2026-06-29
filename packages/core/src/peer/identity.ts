import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/** Thrown when a peer identity key cannot be parsed or used. */
export class PeerIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PeerIdentityError';
  }
}

/** A persistent Ed25519 identity for one CostGoblin instance. The private key
 *  never leaves the machine; the public key is what a peer pins — it travels
 *  inside a sharing key, so the consumer authenticates the channel against it
 *  with no separate confirmation step (handing over the key is the exchange). */
export interface IdentityKeyPair {
  /** Raw Ed25519 public key (32 bytes), base64url. */
  readonly publicKey: string;
  /** PKCS#8 private key, PEM. Stays on disk, owner-only. */
  readonly privateKey: string;
}

/** Export an Ed25519 public KeyObject as its raw 32-byte value, base64url. */
function publicKeyToB64url(pub: KeyObject): string {
  const jwk = pub.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string') {
    throw new PeerIdentityError('Failed to export Ed25519 public key');
  }
  return jwk.x;
}

/** Reconstruct an Ed25519 public KeyObject from its raw base64url value. */
function publicKeyFromB64url(publicKey: string): KeyObject {
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
  } catch {
    throw new PeerIdentityError('Invalid Ed25519 public key');
  }
}

/** Generate a fresh Ed25519 identity. Call once per instance, then persist. */
export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKeyToB64url(publicKey),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

/** True when `publicKey` is a well-formed raw Ed25519 public key (base64url). */
export function isValidPublicKey(publicKey: string): boolean {
  return Buffer.from(publicKey, 'base64url').length === 32;
}

/** A short, human-comparable fingerprint of a public key, e.g. for showing in
 *  the UI so two colleagues can eyeball that they pinned the same identity. */
export function publicKeyFingerprint(publicKey: string): string {
  const hex = createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex');
  return hex.slice(0, 16).replace(/(.{4})(?=.)/g, '$1-').toUpperCase();
}

/** Sign bytes with a PKCS#8 PEM private key. Returns a base64url signature. */
export function signBytes(privateKeyPem: string, data: Buffer): string {
  return cryptoSign(null, data, createPrivateKey(privateKeyPem)).toString('base64url');
}

/** Verify a base64url Ed25519 signature against a raw base64url public key. */
export function verifyBytes(publicKey: string, data: Buffer, signature: string): boolean {
  return cryptoVerify(null, data, publicKeyFromB64url(publicKey), Buffer.from(signature, 'base64url'));
}
