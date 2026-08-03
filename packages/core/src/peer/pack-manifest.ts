import { createHash } from 'node:crypto';
import { isStringRecord } from '../utils/json.js';
import { isValidPublicKey, signBytes, verifyBytes } from './identity.js';

/** Thrown when a pack manifest is malformed or fails validation. */
export class PackManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackManifestError';
  }
}

/** v2 (#516): file paths carry a provider-name segment ({provider}/raw/...)
 *  instead of the fixed `aws/raw/...` of v1. v1 packs are still accepted —
 *  their paths classify as provider 'aws' and the importer maps them onto a
 *  local provider. */
export const PACK_MANIFEST_VERSION = 2;
export type PackManifestVersion = 1 | typeof PACK_MANIFEST_VERSION;

function isAcceptedPackVersion(v: unknown): v is PackManifestVersion {
  return v === 1 || v === PACK_MANIFEST_VERSION;
}

/** One Parquet data file in a snapshot. The consumer drops it byte-identical
 *  into its local data tree and queries it in place — no ETL. */
export interface PackFileEntry {
  /** Relative path under the data root, e.g.
   *  "aws-main/raw/daily-2026-06/x.parquet" (v1 packs: "aws/raw/..."). The
   *  leading segment is the publisher's provider name; the importer remaps
   *  it onto one of its own configured providers. */
  readonly path: string;
  readonly size: number;
  /** SHA-256 of the file contents, lowercase hex. */
  readonly sha256: string;
}

/** Per-machine enrichment (AWS-Org/SSM-gated) carried inline so an S3-less
 *  consumer sees real account/region names instead of raw IDs. Small JSON. */
export interface PackEnrichment {
  readonly orgAccounts: string | null;
  readonly regionNames: string | null;
  readonly orgAccountTags: string | null;
}

/** Describes a data+config snapshot. Signed as a whole by the publisher, so
 *  the inline config/enrichment and the per-file hashes are all tamper-evident. */
export interface PackManifest {
  /** The version the pack was PUBLISHED with — preserved verbatim on parse
   *  so signature verification sees the exact signed bytes. New packs are
   *  always written with PACK_MANIFEST_VERSION. */
  readonly v: PackManifestVersion;
  readonly createdAt: string;
  /** Publisher Ed25519 public key (raw, base64url) — pins the source. */
  readonly publisher: string;
  readonly label: string;
  /** Serialized config bundle (#354 YAML) shared with the data, or null. */
  readonly configBundle: string | null;
  readonly enrichment: PackEnrichment;
  readonly files: readonly PackFileEntry[];
}

export interface SignedPackManifest {
  readonly manifest: PackManifest;
  /** Ed25519 signature (base64url) over the canonical manifest bytes. */
  readonly signature: string;
}

/** SHA-256 of a byte buffer, lowercase hex — used to hash each data file. */
export function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Deterministic, key-sorted serialization so signing and verifying produce
 *  identical bytes regardless of JSON key order on either machine. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const pairs = entries.map(([k, v]) => {
    const pair = `${JSON.stringify(k)}:${stableStringify(v)}`;
    return pair;
  });
  return `{${pairs.join(',')}}`;
}

function canonicalManifestBytes(manifest: PackManifest): Buffer {
  return Buffer.from(stableStringify(manifest), 'utf-8');
}

export function signManifest(manifest: PackManifest, privateKeyPem: string): SignedPackManifest {
  return { manifest, signature: signBytes(privateKeyPem, canonicalManifestBytes(manifest)) };
}

/** Verify the signature was produced by the manifest's stated publisher key.
 *  The caller must still check that `publisher` is a key it has pinned. */
export function verifyManifestSignature(signed: SignedPackManifest): boolean {
  return verifyBytes(signed.manifest.publisher, canonicalManifestBytes(signed.manifest), signed.signature);
}

export function serializeSignedManifest(signed: SignedPackManifest): string {
  return JSON.stringify(signed);
}

/** Pack file paths are written to disk by the consumer, so they are confined
 *  to the data tree: `{provider}/raw/{tier}-{period}/<file>.parquet`, no
 *  traversal. The provider segment charset mirrors PROVIDER_NAME_PATTERN
 *  (no dots, no separators), so `..` cannot appear in it; the filename part
 *  allows dots but the explicit `..` check below rejects traversal anyway. */
const PACK_FILE_PATH = /^[A-Za-z0-9][A-Za-z0-9_-]*\/raw\/[a-z][a-z-]*-\d{4}-\d{2}(?:-\d{2})?\/[A-Za-z0-9._-]+\.parquet$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isSafePackPath(path: string): boolean {
  return !path.includes('..') && PACK_FILE_PATH.test(path);
}

/** A data tier as named in selections/availability. The on-disk directory
 *  prefix differs for cost-optimization (`cost-opt`), so callers must not
 *  assume tier === prefix. */
export type PackTier = 'daily' | 'hourly' | 'cost-optimization';

/** Maps an on-disk `{provider}/raw/` directory prefix to its tier. Mirrors
 *  sync-utils' TIER_RAW_PREFIXES; kept here so the peer module stays
 *  self-contained. */
const TIER_BY_PREFIX: ReadonlyMap<string, PackTier> = new Map([
  ['daily', 'daily'],
  ['hourly', 'hourly'],
  ['cost-opt', 'cost-optimization'],
]);

/** Classify a pack file path — `{provider}/raw/{prefix}-{YYYY-MM}[-DD]/<file>.parquet`
 *  — into the publisher's provider name, its tier, and YYYY-MM period.
 *  Returns null for paths that don't match a known tier prefix. NOTE: do not
 *  reuse a `[a-z-]+` period regex for this — it swallows the prefix and
 *  can't distinguish daily/hourly/cost-opt. v1 packs classify as provider
 *  'aws' (the fixed segment of the old layout). */
export function classifyPackPath(path: string): { readonly provider: string; readonly tier: PackTier; readonly period: string } | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/raw\/([a-z][a-z-]*)-(\d{4}-\d{2})(?:-\d{2})?\//.exec(path);
  const provider = m?.[1];
  const prefix = m?.[2];
  const period = m?.[3];
  if (provider === undefined || prefix === undefined || period === undefined) return null;
  const tier = TIER_BY_PREFIX.get(prefix);
  return tier === undefined ? null : { provider, tier, period };
}

function validateEnrichment(raw: unknown): PackEnrichment {
  if (!isStringRecord(raw)) throw new PackManifestError('manifest.enrichment is malformed');
  const field = (key: string): string | null => {
    const v = raw[key];
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throw new PackManifestError(`manifest.enrichment.${key} must be a string or null`);
    return v;
  };
  return { orgAccounts: field('orgAccounts'), regionNames: field('regionNames'), orgAccountTags: field('orgAccountTags') };
}

function validateFile(raw: unknown, i: number): PackFileEntry {
  if (!isStringRecord(raw)) throw new PackManifestError(`manifest.files[${String(i)}] is malformed`);
  const { path, size, sha256 } = raw;
  if (typeof path !== 'string' || !isSafePackPath(path)) {
    throw new PackManifestError(`manifest.files[${String(i)}].path is unsafe or invalid`);
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0) {
    throw new PackManifestError(`manifest.files[${String(i)}].size is invalid`);
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new PackManifestError(`manifest.files[${String(i)}].sha256 is invalid`);
  }
  return { path, size, sha256 };
}

function validateManifest(raw: unknown): PackManifest {
  if (!isStringRecord(raw)) throw new PackManifestError('manifest is malformed');
  const version = raw['v'];
  if (!isAcceptedPackVersion(version)) {
    throw new PackManifestError(`Unsupported pack manifest version (${String(raw['v'])})`);
  }
  const createdAt = raw['createdAt'];
  if (typeof createdAt !== 'string' || createdAt.length === 0) throw new PackManifestError('manifest.createdAt is invalid');
  const publisher = raw['publisher'];
  if (typeof publisher !== 'string' || !isValidPublicKey(publisher)) throw new PackManifestError('manifest.publisher is invalid');
  const label = raw['label'];
  if (typeof label !== 'string' || label.length === 0 || label.length > 200) throw new PackManifestError('manifest.label is invalid');
  const configBundle = raw['configBundle'];
  if (configBundle !== null && typeof configBundle !== 'string') throw new PackManifestError('manifest.configBundle must be a string or null');
  const files = raw['files'];
  if (!Array.isArray(files)) throw new PackManifestError('manifest.files must be an array');
  return {
    v: version,
    createdAt,
    publisher,
    label,
    configBundle,
    enrichment: validateEnrichment(raw['enrichment']),
    files: files.map((file, i) => validateFile(file, i)),
  };
}

/** Parse and structurally validate a transported manifest. Does NOT verify the
 *  signature or trust the publisher — call `verifyManifestSignature` and check
 *  the publisher key against your pinned set afterwards. */
export function parseSignedManifest(json: string): SignedPackManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new PackManifestError('Pack manifest is not valid JSON');
  }
  if (!isStringRecord(raw)) throw new PackManifestError('Pack manifest is malformed');
  const signature = raw['signature'];
  if (typeof signature !== 'string' || signature.length === 0) throw new PackManifestError('Pack manifest signature is missing');
  return { manifest: validateManifest(raw['manifest']), signature };
}
