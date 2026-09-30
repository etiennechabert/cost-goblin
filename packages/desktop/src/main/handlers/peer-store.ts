import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import {
  generateIdentityKeyPair,
  isStringRecord,
  parseJsonObjectFile,
  readTextIfExists,
  writeFileAtomic,
  type IdentityKeyPair,
  type SharedPullSelection,
  type SharedSourceTier,
} from '@costgoblin/core';

const SHARED_SOURCE_TIERS: readonly SharedSourceTier[] = ['config', 'daily', 'hourly', 'cost-optimization'];

/** Parse/validate an untrusted selection (from a persisted file or the
 *  renderer), tolerating absence → undefined ("pull everything", the
 *  back-compatible default). */
export function parseSharedPullSelection(raw: unknown): SharedPullSelection | undefined {
  // Absent (not an object) means "no choice made" → pull everything. A present
  // object with zero valid sources is a real, if empty, selection → pull
  // nothing; we must NOT collapse it back to "everything".
  if (!isStringRecord(raw)) return undefined;
  const sources = Array.isArray(raw['sources'])
    ? raw['sources'].filter((s: unknown): s is SharedSourceTier => typeof s === 'string' && (SHARED_SOURCE_TIERS as readonly string[]).includes(s))
    : [];
  const periods = Array.isArray(raw['periods'])
    ? raw['periods'].filter((p: unknown): p is string => typeof p === 'string')
    : undefined;
  return periods === undefined ? { sources } : { sources, periods };
}

/** Peer-sharing secrets live alongside the YAML config, owner-only (0600). */
function configDir(configPath: string): string {
  return dirname(configPath);
}

function readJson(path: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    return isStringRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSecret(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // 0o600: only the current user can read the private key / access secret.
  await writeFileAtomic(path, JSON.stringify(value, null, 2), { mode: 0o600 });
}

// Load-or-create is a read-then-write: two first uses at once would each mint
// a secret, and the one whose write lands second would silently replace the
// other's. Each file's operations run one at a time.
const secretChains = new Map<string, Promise<void>>();

function serializedOn<T>(path: string, op: () => Promise<T>): Promise<T> {
  const run = (secretChains.get(path) ?? Promise.resolve()).then(op);
  // Settles with nothing: the chain must not hold on to the secret it read.
  secretChains.set(path, run.then(() => undefined, () => undefined));
  return run;
}

/** The secret in `file`, created on first use. Only a missing file means first
 *  use. Anything else throws, leaving the file alone: minting a replacement
 *  over one that was merely locked (EBUSY, EMFILE — transient errors are
 *  retried first), torn or hand-damaged would silently change this machine's
 *  identity or break every sharing key handed out. */
function loadOrCreateSecret<T extends object>(
  file: string,
  parse: (doc: Readonly<Record<string, unknown>>) => T | null,
  create: () => T,
): Promise<T> {
  return serializedOn(file, async () => {
    const text = await readTextIfExists(file);
    if (text === null) {
      const secret = create();
      await writeSecret(file, secret);
      return secret;
    }
    const doc = parseJsonObjectFile(text);
    const secret = doc === null ? null : parse(doc);
    if (secret === null) {
      throw new Error(`${file} is unreadable; refusing to replace it (move it aside to have a new one created)`);
    }
    return secret;
  });
}

function defaultLabel(): string {
  const host = hostname();
  return host.length > 0 ? `${host} · CostGoblin` : 'CostGoblin';
}

/** This machine's persistent Ed25519 identity, created on first use. The
 *  private key never leaves disk; the public key is what peers pin. */
export function loadOrCreateIdentity(configPath: string): Promise<IdentityKeyPair> {
  return loadOrCreateSecret(
    join(configDir(configPath), 'peer-identity.json'),
    (doc) => typeof doc['publicKey'] === 'string' && typeof doc['privateKey'] === 'string'
      ? { publicKey: doc['publicKey'], privateKey: doc['privateKey'] }
      : null,
    generateIdentityKeyPair,
  );
}

export interface SharingSecret {
  readonly psk: string;
  readonly label: string;
}

/** The access secret + friendly label advertised to peers. Stable across
 *  restarts so a handed-out sharing key keeps working until rotation. */
export function loadOrCreateSharingSecret(configPath: string): Promise<SharingSecret> {
  return loadOrCreateSecret(
    join(configDir(configPath), 'peer-sharing.json'),
    (doc) => typeof doc['psk'] === 'string' && typeof doc['label'] === 'string'
      ? { psk: doc['psk'], label: doc['label'] }
      : null,
    () => ({ psk: randomBytes(32).toString('base64url'), label: defaultLabel() }),
  );
}

/** Replace the access secret — any outstanding sharing key stops working.
 *  Rotation doesn't need the old secret, so it also replaces an unparseable
 *  file (only its label is lost). A read failure still throws, rather than
 *  drop a label that is intact on disk. */
export function rotateSharingSecret(configPath: string): Promise<SharingSecret> {
  const file = join(configDir(configPath), 'peer-sharing.json');
  return serializedOn(file, async () => {
    const text = await readTextIfExists(file);
    const existing = text === null ? null : parseJsonObjectFile(text);
    const label = existing !== null && typeof existing['label'] === 'string' ? existing['label'] : defaultLabel();
    const secret: SharingSecret = { psk: randomBytes(32).toString('base64url'), label };
    await writeSecret(file, secret);
    return secret;
  });
}

/** The single shared source a consumer pulls from. The full sharing key is
 *  kept so a refresh can reconnect without re-pasting it. */
export interface StoredSharedSource {
  readonly key: string;
  readonly label: string;
  readonly fingerprint: string;
  readonly host: string;
  readonly port: number;
  readonly lastPulledAt: string | null;
  readonly periods: readonly string[];
  /** The tiers/periods last chosen, reused on refresh. Undefined = everything. */
  readonly selection?: SharedPullSelection | undefined;
}

export function loadSharedSource(configPath: string): StoredSharedSource | null {
  const r = readJson(join(configDir(configPath), 'peer-source.json'));
  if (r === null) return null;
  if (
    typeof r['key'] !== 'string' ||
    typeof r['label'] !== 'string' ||
    typeof r['fingerprint'] !== 'string' ||
    typeof r['host'] !== 'string' ||
    typeof r['port'] !== 'number'
  ) {
    return null;
  }
  const periods = Array.isArray(r['periods']) ? r['periods'].filter((p: unknown): p is string => typeof p === 'string') : [];
  const lastPulledAt = typeof r['lastPulledAt'] === 'string' ? r['lastPulledAt'] : null;
  const selection = parseSharedPullSelection(r['selection']);
  return {
    key: r['key'], label: r['label'], fingerprint: r['fingerprint'], host: r['host'], port: r['port'], lastPulledAt, periods,
    ...(selection === undefined ? {} : { selection }),
  };
}

export async function saveSharedSource(configPath: string, source: StoredSharedSource): Promise<void> {
  await writeSecret(join(configDir(configPath), 'peer-source.json'), source);
}

export function clearSharedSource(configPath: string): void {
  try {
    rmSync(join(configDir(configPath), 'peer-source.json'));
  } catch {
    // already gone
  }
}
