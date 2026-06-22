import { isStringRecord } from '../utils/json.js';
import { isValidPublicKey } from './identity.js';

/** Thrown when a sharing key is malformed, corrupt, or unsupported. */
export class SharingKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SharingKeyError';
  }
}

export const SHARING_KEY_VERSION = 1;
const SHARING_KEY_PREFIX = 'CGSHARE1-';

/** Everything a consumer needs to connect to a publisher, packed into one
 *  copy-paste token — so no network broadcast/discovery is required. The
 *  publisher generates it on "enable sharing"; the consumer pastes it.
 *
 *  `pub` (the publisher's Ed25519 public key) is the trust anchor: the channel
 *  is authenticated against it, so a rogue peer cannot impersonate the source.
 *  `psk` is the access secret: only a holder of the key can connect, and it
 *  seeds the session encryption. */
export interface SharingKeyPayload {
  readonly v: typeof SHARING_KEY_VERSION;
  /** Candidate LAN addresses of the publisher (one per network interface). */
  readonly hosts: readonly string[];
  readonly port: number;
  /** Publisher Ed25519 public key, raw 32 bytes, base64url. */
  readonly pub: string;
  /** Access secret, base64url (>= 16 bytes of entropy). */
  readonly psk: string;
  /** Friendly label, e.g. "Etienne's CostGoblin". */
  readonly label: string;
}

export function encodeSharingKey(payload: SharingKeyPayload): string {
  return SHARING_KEY_PREFIX + Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
}

export function parseSharingKey(key: string): SharingKeyPayload {
  const trimmed = key.trim();
  if (!trimmed.startsWith(SHARING_KEY_PREFIX)) {
    throw new SharingKeyError('This does not look like a CostGoblin sharing key.');
  }
  const json = Buffer.from(trimmed.slice(SHARING_KEY_PREFIX.length), 'base64url').toString('utf-8');
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SharingKeyError('Sharing key is corrupt or incomplete.');
  }
  return validateSharingKeyPayload(raw);
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HOSTNAME = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}))*$/;

function isValidHost(host: string): boolean {
  const m = IPV4.exec(host);
  if (m !== null) return m.slice(1).every(octet => Number(octet) <= 255);
  return host.length <= 253 && HOSTNAME.test(host);
}

function decodedLength(b64url: string): number {
  return Buffer.from(b64url, 'base64url').length;
}

function validateSharingKeyPayload(raw: unknown): SharingKeyPayload {
  if (!isStringRecord(raw)) {
    throw new SharingKeyError('Sharing key payload is malformed.');
  }
  if (raw['v'] !== SHARING_KEY_VERSION) {
    throw new SharingKeyError(`Unsupported sharing key version (${String(raw['v'])}). Update CostGoblin and retry.`);
  }
  const hosts = raw['hosts'];
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new SharingKeyError('Sharing key has no host addresses.');
  }
  if (!hosts.every((h: unknown): h is string => typeof h === 'string' && isValidHost(h))) {
    throw new SharingKeyError('Sharing key has an invalid host address.');
  }
  const port = raw['port'];
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SharingKeyError('Sharing key has an invalid port.');
  }
  const pub = raw['pub'];
  if (typeof pub !== 'string' || !isValidPublicKey(pub)) {
    throw new SharingKeyError('Sharing key has an invalid public key.');
  }
  const psk = raw['psk'];
  if (typeof psk !== 'string' || decodedLength(psk) < 16) {
    throw new SharingKeyError('Sharing key has an invalid access secret.');
  }
  const label = raw['label'];
  if (typeof label !== 'string' || label.length === 0 || label.length > 200) {
    throw new SharingKeyError('Sharing key has an invalid label.');
  }
  return { v: SHARING_KEY_VERSION, hosts, port, pub, psk, label };
}
