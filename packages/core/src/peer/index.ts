export {
  generateIdentityKeyPair,
  isValidPublicKey,
  publicKeyFingerprint,
  signBytes,
  verifyBytes,
  PeerIdentityError,
} from './identity.js';
export type { IdentityKeyPair } from './identity.js';
export {
  encodeSharingKey,
  parseSharingKey,
  SharingKeyError,
  SHARING_KEY_VERSION,
} from './sharing-key.js';
export type { SharingKeyPayload } from './sharing-key.js';
export {
  isSafePackPath,
  parseSignedManifest,
  serializeSignedManifest,
  sha256Hex,
  signManifest,
  verifyManifestSignature,
  PackManifestError,
  PACK_MANIFEST_VERSION,
} from './pack-manifest.js';
export type {
  PackEnrichment,
  PackFileEntry,
  PackManifest,
  SignedPackManifest,
} from './pack-manifest.js';
export { startSharingServer } from './secure-server.js';
export type { SharingAccessEvent, SharingServer, SharingServerConfig, SharingServerHandlers } from './secure-server.js';
export { fetchManifest, fetchFile } from './secure-client.js';
export type { PeerEndpoint } from './secure-client.js';
export {
  SHARING_PSK_IDENTITY,
  SHARING_TLS_CIPHERS,
  SHARING_TLS_MAX_VERSION,
  SHARING_TLS_MIN_VERSION,
} from './tls-psk.js';
