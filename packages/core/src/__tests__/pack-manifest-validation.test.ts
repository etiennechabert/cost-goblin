import { describe, it, expect } from 'vitest';
import { generateIdentityKeyPair } from '../peer/identity.js';
import { parseSignedManifest, PackManifestError, PACK_MANIFEST_VERSION } from '../peer/pack-manifest.js';

/**
 * A pack manifest arrives from a peer over the network, and the consumer
 * writes files to disk from it, so its shape is validated field by field
 * before anything trusts it. Each rejection names the offending field.
 */

const PUBLISHER = generateIdentityKeyPair().publicKey;
const GOOD_SHA = 'a'.repeat(64);
const GOOD_FILE = { path: 'aws/raw/daily-2026-06/part-0.parquet', size: 1024, sha256: GOOD_SHA };

function rawManifest(): Record<string, unknown> {
  return {
    v: PACK_MANIFEST_VERSION,
    createdAt: '2026-06-21T00:00:00.000Z',
    publisher: PUBLISHER,
    label: 'Team pack',
    configBundle: null,
    enrichment: { orgAccounts: null, regionNames: null, orgAccountTags: null },
    files: [GOOD_FILE],
  };
}

/** A transported pack whose manifest has `overrides` applied; an `undefined`
 *  override drops the key (JSON.stringify omits it). */
function transported(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ manifest: { ...rawManifest(), ...overrides }, signature: 'c2lnbmF0dXJl' });
}

/** The PackManifestError message `json` is rejected with. */
function rejection(json: string): string {
  try {
    parseSignedManifest(json);
  } catch (err: unknown) {
    if (err instanceof PackManifestError) return err.message;
    throw err;
  }
  throw new Error('expected the manifest to be rejected');
}

describe('parseSignedManifest accepts well-formed manifests', () => {
  it('parses every field and keeps the signature', () => {
    const parsed = parseSignedManifest(transported({ configBundle: 'kind: costgoblin-config-bundle\n' }));
    expect(parsed.signature).toBe('c2lnbmF0dXJl');
    expect(parsed.manifest).toEqual({ ...rawManifest(), configBundle: 'kind: costgoblin-config-bundle\n' });
  });

  it('reads absent enrichment fields as null', () => {
    const parsed = parseSignedManifest(transported({ enrichment: {} }));
    expect(parsed.manifest.enrichment).toEqual({ orgAccounts: null, regionNames: null, orgAccountTags: null });
  });

  it('accepts the boundaries: an empty pack, a 200-character label, a zero-byte file', () => {
    expect(parseSignedManifest(transported({ files: [] })).manifest.files).toEqual([]);
    expect(parseSignedManifest(transported({ label: 'x'.repeat(200) })).manifest.label).toHaveLength(200);
    expect(parseSignedManifest(transported({ files: [{ ...GOOD_FILE, size: 0 }] })).manifest.files[0]?.size).toBe(0);
  });
});

describe('parseSignedManifest rejects a malformed envelope', () => {
  it.each(['[]', 'null', '42', '"pack"'])('rejects a top-level %s', (json) => {
    expect(rejection(json)).toBe('Pack manifest is malformed');
  });

  it.each([
    { name: 'a missing signature', signature: undefined },
    { name: 'a numeric signature', signature: 7 },
    { name: 'an empty signature', signature: '' },
  ])('rejects $name', ({ signature }) => {
    expect(rejection(JSON.stringify({ manifest: rawManifest(), signature }))).toBe('Pack manifest signature is missing');
  });

  it.each([
    { name: 'missing', manifest: undefined },
    { name: 'null', manifest: null },
    { name: 'an array', manifest: [rawManifest()] },
    { name: 'a string', manifest: 'manifest' },
  ])('rejects a manifest that is $name', ({ manifest }) => {
    expect(rejection(JSON.stringify({ manifest, signature: 'c2ln' }))).toBe('manifest is malformed');
  });
});

describe('parseSignedManifest rejects an invalid manifest field', () => {
  const tooShortKey = Buffer.alloc(31, 7).toString('base64url');
  const tooLongKey = Buffer.alloc(33, 7).toString('base64url');

  it.each([
    { name: 'a future version', overrides: { v: 3 }, message: 'Unsupported pack manifest version (3)' },
    { name: 'version 0', overrides: { v: 0 }, message: 'Unsupported pack manifest version (0)' },
    { name: 'a string version', overrides: { v: '2' }, message: 'Unsupported pack manifest version (2)' },
    { name: 'a missing version', overrides: { v: undefined }, message: 'Unsupported pack manifest version (undefined)' },
    { name: 'a missing createdAt', overrides: { createdAt: undefined }, message: 'manifest.createdAt is invalid' },
    { name: 'a numeric createdAt', overrides: { createdAt: 1_750_000_000 }, message: 'manifest.createdAt is invalid' },
    { name: 'an empty createdAt', overrides: { createdAt: '' }, message: 'manifest.createdAt is invalid' },
    { name: 'a missing publisher', overrides: { publisher: undefined }, message: 'manifest.publisher is invalid' },
    { name: 'a numeric publisher', overrides: { publisher: 32 }, message: 'manifest.publisher is invalid' },
    { name: 'a 31-byte publisher key', overrides: { publisher: tooShortKey }, message: 'manifest.publisher is invalid' },
    { name: 'a 33-byte publisher key', overrides: { publisher: tooLongKey }, message: 'manifest.publisher is invalid' },
    { name: 'a missing label', overrides: { label: undefined }, message: 'manifest.label is invalid' },
    { name: 'a numeric label', overrides: { label: 5 }, message: 'manifest.label is invalid' },
    { name: 'an empty label', overrides: { label: '' }, message: 'manifest.label is invalid' },
    { name: 'a 201-character label', overrides: { label: 'x'.repeat(201) }, message: 'manifest.label is invalid' },
    { name: 'a missing configBundle', overrides: { configBundle: undefined }, message: 'manifest.configBundle must be a string or null' },
    { name: 'a numeric configBundle', overrides: { configBundle: 5 }, message: 'manifest.configBundle must be a string or null' },
    { name: 'an object configBundle', overrides: { configBundle: { kind: 'x' } }, message: 'manifest.configBundle must be a string or null' },
    { name: 'missing files', overrides: { files: undefined }, message: 'manifest.files must be an array' },
    { name: 'files as an object', overrides: { files: { 0: GOOD_FILE } }, message: 'manifest.files must be an array' },
    { name: 'null files', overrides: { files: null }, message: 'manifest.files must be an array' },
    { name: 'a missing enrichment', overrides: { enrichment: undefined }, message: 'manifest.enrichment is malformed' },
    { name: 'a null enrichment', overrides: { enrichment: null }, message: 'manifest.enrichment is malformed' },
    { name: 'an array enrichment', overrides: { enrichment: [] }, message: 'manifest.enrichment is malformed' },
    { name: 'a numeric orgAccounts', overrides: { enrichment: { orgAccounts: 5 } }, message: 'manifest.enrichment.orgAccounts must be a string or null' },
    { name: 'an object regionNames', overrides: { enrichment: { regionNames: {} } }, message: 'manifest.enrichment.regionNames must be a string or null' },
    { name: 'an array orgAccountTags', overrides: { enrichment: { orgAccountTags: [] } }, message: 'manifest.enrichment.orgAccountTags must be a string or null' },
  ])('rejects $name', ({ overrides, message }) => {
    expect(rejection(transported(overrides))).toBe(message);
  });
});

describe('parseSignedManifest rejects an invalid file entry', () => {
  it.each([
    { name: 'a null entry', file: null, message: 'manifest.files[0] is malformed' },
    { name: 'a string entry', file: 'aws/raw/daily-2026-06/part-0.parquet', message: 'manifest.files[0] is malformed' },
    { name: 'an array entry', file: [GOOD_FILE], message: 'manifest.files[0] is malformed' },
    { name: 'a missing path', file: { ...GOOD_FILE, path: undefined }, message: 'manifest.files[0].path is unsafe or invalid' },
    { name: 'a numeric path', file: { ...GOOD_FILE, path: 42 }, message: 'manifest.files[0].path is unsafe or invalid' },
    { name: 'a traversing path', file: { ...GOOD_FILE, path: 'aws/raw/daily-2026-06/../x.parquet' }, message: 'manifest.files[0].path is unsafe or invalid' },
    { name: 'a missing size', file: { ...GOOD_FILE, size: undefined }, message: 'manifest.files[0].size is invalid' },
    { name: 'a string size', file: { ...GOOD_FILE, size: '1024' }, message: 'manifest.files[0].size is invalid' },
    { name: 'a fractional size', file: { ...GOOD_FILE, size: 1.5 }, message: 'manifest.files[0].size is invalid' },
    { name: 'a negative size', file: { ...GOOD_FILE, size: -1 }, message: 'manifest.files[0].size is invalid' },
    { name: 'a missing sha256', file: { ...GOOD_FILE, sha256: undefined }, message: 'manifest.files[0].sha256 is invalid' },
    { name: 'a numeric sha256', file: { ...GOOD_FILE, sha256: 7 }, message: 'manifest.files[0].sha256 is invalid' },
    { name: 'an upper-case sha256', file: { ...GOOD_FILE, sha256: 'A'.repeat(64) }, message: 'manifest.files[0].sha256 is invalid' },
    { name: 'a short sha256', file: { ...GOOD_FILE, sha256: 'a'.repeat(63) }, message: 'manifest.files[0].sha256 is invalid' },
    { name: 'a non-hex sha256', file: { ...GOOD_FILE, sha256: 'g'.repeat(64) }, message: 'manifest.files[0].sha256 is invalid' },
  ])('rejects $name', ({ file, message }) => {
    expect(rejection(transported({ files: [file] }))).toBe(message);
  });

  it('names the index of the first bad entry', () => {
    expect(rejection(transported({ files: [GOOD_FILE, GOOD_FILE, 5] }))).toBe('manifest.files[2] is malformed');
    expect(rejection(transported({ files: [GOOD_FILE, { ...GOOD_FILE, size: -5 }] }))).toBe('manifest.files[1].size is invalid');
  });
});
