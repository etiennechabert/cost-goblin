import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidPublicKey } from '@costgoblin/core';
import {
  clearSharedSource,
  loadOrCreateIdentity,
  loadOrCreateSharingSecret,
  loadSharedSource,
  parseSharedPullSelection,
  rotateSharingSecret,
  saveSharedSource,
  type StoredSharedSource,
} from '../main/handlers/peer-store.js';

/** Peer-sharing secrets and the stored shared source: what survives a
 *  restart, what a corrupt or hand-edited file degrades to, and the
 *  renderer-selection parser. */

const host = vi.hoisted(() => ({ name: 'build-box' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, hostname: () => host.name };
});

let dir = '';
let configPath = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cg-peer-store-'));
  configPath = join(dir, 'config', 'costgoblin.yaml');
  mkdirSync(join(dir, 'config'));
  host.name = 'build-box';
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string): string => join(dir, 'config', name);

describe('parseSharedPullSelection', () => {
  it('treats a missing or non-object selection as "pull everything"', () => {
    expect(parseSharedPullSelection(undefined)).toBeUndefined();
    expect(parseSharedPullSelection(null)).toBeUndefined();
    expect(parseSharedPullSelection('daily')).toBeUndefined();
  });

  it('keeps only known tiers and string periods', () => {
    expect(parseSharedPullSelection({ sources: ['daily', 'weekly', 7, 'config'], periods: ['2026-01', 3] }))
      .toEqual({ sources: ['daily', 'config'], periods: ['2026-01'] });
    expect(parseSharedPullSelection({ sources: ['hourly'] })).toEqual({ sources: ['hourly'] });
  });

  it('keeps an object with no usable sources as an explicit empty selection', () => {
    expect(parseSharedPullSelection({ sources: 'daily' })).toEqual({ sources: [] });
    expect(parseSharedPullSelection({ periods: ['2026-02'] })).toEqual({ sources: [], periods: ['2026-02'] });
  });
});

describe('identity and sharing secret', () => {
  it('creates an Ed25519 identity once, owner-only, and reloads it', () => {
    const created = loadOrCreateIdentity(configPath);
    expect(isValidPublicKey(created.publicKey)).toBe(true);
    expect(created.privateKey).toContain('PRIVATE KEY');
    if (process.platform !== 'win32') {
      expect(statSync(file('peer-identity.json')).mode & 0o777).toBe(0o600);
    }
    expect(loadOrCreateIdentity(configPath)).toEqual(created);
  });

  it('replaces an identity file that lost its keys', () => {
    loadOrCreateIdentity(configPath);
    writeFileSync(file('peer-identity.json'), JSON.stringify({ publicKey: 'only-half' }));
    const fresh = loadOrCreateIdentity(configPath);
    expect(isValidPublicKey(fresh.publicKey)).toBe(true);
  });

  it('labels the secret with the host name, or just the app when the host has none', () => {
    expect(loadOrCreateSharingSecret(configPath).label).toBe('build-box · CostGoblin');
    rmSync(file('peer-sharing.json'));
    host.name = '';
    expect(loadOrCreateSharingSecret(configPath).label).toBe('CostGoblin');
  });

  it('keeps the secret stable until rotated, and rotation keeps the label', () => {
    const first = loadOrCreateSharingSecret(configPath);
    expect(Buffer.from(first.psk, 'base64url')).toHaveLength(32);
    expect(loadOrCreateSharingSecret(configPath)).toEqual(first);
    const rotated = rotateSharingSecret(configPath);
    expect(rotated.label).toBe(first.label);
    expect(rotated.psk).not.toBe(first.psk);
    expect(loadOrCreateSharingSecret(configPath)).toEqual(rotated);
  });

  it('rotates even with no secret on disk yet, or one that is not a JSON object', () => {
    expect(rotateSharingSecret(configPath).label).toBe('build-box · CostGoblin');
    writeFileSync(file('peer-sharing.json'), '["not", "an", "object"]');
    host.name = 'renamed';
    expect(rotateSharingSecret(configPath).label).toBe('renamed · CostGoblin');
  });
});

describe('stored shared source', () => {
  const source: StoredSharedSource = {
    key: 'CGSHARE1-abc',
    label: 'Teammate',
    fingerprint: 'AB:CD',
    host: '10.0.0.5',
    port: 53178,
    lastPulledAt: '2026-02-21T00:00:00.000Z',
    periods: ['2026-01', '2026-02'],
    selection: { sources: ['daily'], periods: ['2026-02'] },
  };

  it('round-trips a saved source, selection included', () => {
    expect(loadSharedSource(configPath)).toBeNull();
    saveSharedSource(configPath, source);
    expect(loadSharedSource(configPath)).toEqual(source);
  });

  it('omits the selection key when none was saved', () => {
    const unscoped: StoredSharedSource = {
      key: source.key, label: source.label, fingerprint: source.fingerprint, host: source.host, port: source.port,
      lastPulledAt: source.lastPulledAt, periods: source.periods,
    };
    saveSharedSource(configPath, unscoped);
    const loaded = loadSharedSource(configPath);
    expect(loaded).toEqual(unscoped);
    expect(loaded !== null && 'selection' in loaded).toBe(false);
  });

  it('rejects a record missing a required field', () => {
    for (const broken of [
      { ...source, key: 1 },
      { ...source, label: null },
      { ...source, fingerprint: undefined },
      { ...source, host: ['10.0.0.5'] },
      { ...source, port: '53178' },
    ]) {
      writeFileSync(file('peer-source.json'), JSON.stringify(broken));
      expect(loadSharedSource(configPath)).toBeNull();
    }
  });

  it('degrades optional fields it cannot read', () => {
    saveSharedSource(configPath, source);
    writeFileSync(file('peer-source.json'), JSON.stringify({ ...source, periods: '2026-01', lastPulledAt: 0, selection: 'all' }));
    expect(loadSharedSource(configPath)).toEqual({
      key: source.key, label: source.label, fingerprint: source.fingerprint, host: source.host, port: source.port,
      lastPulledAt: null, periods: [],
    });
    writeFileSync(file('peer-source.json'), JSON.stringify({ ...source, periods: ['2026-01', 5] }));
    expect(loadSharedSource(configPath)?.periods).toEqual(['2026-01']);
  });

  it('treats unreadable JSON as no source', () => {
    saveSharedSource(configPath, source);
    writeFileSync(file('peer-source.json'), '{ not json');
    expect(loadSharedSource(configPath)).toBeNull();
  });

  it('clears the source, and clearing twice is harmless', () => {
    saveSharedSource(configPath, source);
    clearSharedSource(configPath);
    expect(existsSync(file('peer-source.json'))).toBe(false);
    expect(() => { clearSharedSource(configPath); }).not.toThrow();
  });
});
