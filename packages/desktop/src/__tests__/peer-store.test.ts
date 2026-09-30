import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  loadOrCreateIdentity,
  loadOrCreateSharingSecret,
  rotateSharingSecret,
} from '../main/handlers/peer-store.js';

// Pass-through fs so a case can inject a failure into one read; the secrets
// are read through @costgoblin/core's atomic-file module, which imports this one.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const readFileMock = vi.mocked(readFile);

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

let dir: string;
let configPath: string;
let identityFile: string;
let sharingFile: string;

beforeEach(async () => {
  // Canonical (macOS tmpdir is a symlink): writes resolve their target path.
  dir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-peer-store-')));
  configPath = join(dir, 'costgoblin.yaml');
  identityFile = join(dir, 'peer-identity.json');
  sharingFile = join(dir, 'peer-sharing.json');
});

afterEach(async () => {
  readFileMock.mockReset();
  await rm(dir, { recursive: true, force: true });
});

/** Make every read of `path` fail with `code` until the case resets it. */
function failReads(path: string, code: string): void {
  readFileMock.mockImplementation((file, options) =>
    file === path ? Promise.reject(errnoError(code)) : fsActual.readFile(file, options));
}

/** Fail the first two reads of `path` with transient errors; returns the count. */
function failTransiently(path: string): () => number {
  let failures = 0;
  readFileMock.mockImplementation((file, options) => {
    if (file === path && failures < 2) {
      failures += 1;
      return Promise.reject(errnoError(failures === 1 ? 'EBUSY' : 'EMFILE'));
    }
    return fsActual.readFile(file, options);
  });
  return () => failures;
}

// POSIX permission bits don't exist on Windows (Node's chmod only toggles the
// read-only flag), so the mode assertions are POSIX-only.
const posixOnly = it.skipIf(process.platform === 'win32');

describe('loadOrCreateIdentity', () => {
  it('creates an identity on first use and keeps it across loads', async () => {
    const first = await loadOrCreateIdentity(configPath);
    expect(await loadOrCreateIdentity(configPath)).toEqual(first);
    expect(await readdir(dir)).toEqual(['peer-identity.json']);
  });

  it('gives concurrent first uses the same identity, the one on disk', async () => {
    const [a, b] = await Promise.all([loadOrCreateIdentity(configPath), loadOrCreateIdentity(configPath)]);
    expect(b).toEqual(a);
    expect(JSON.parse(await fsActual.readFile(identityFile, 'utf-8'))).toEqual(a);
  });

  posixOnly('writes the private key owner-only (0600)', async () => {
    await loadOrCreateIdentity(configPath);
    expect((await stat(identityFile)).mode & 0o777).toBe(0o600);
  });

  it('rejects on a read failure other than a missing file, keeping the identity', async () => {
    const identity = await loadOrCreateIdentity(configPath);
    const text = await fsActual.readFile(identityFile, 'utf-8');
    failReads(identityFile, 'EIO');

    await expect(loadOrCreateIdentity(configPath)).rejects.toThrow('EIO');
    readFileMock.mockReset();
    expect(await fsActual.readFile(identityFile, 'utf-8')).toBe(text);
    expect(await loadOrCreateIdentity(configPath)).toEqual(identity);
  });

  it('retries a transient lock or descriptor error instead of minting a new identity', async () => {
    const identity = await loadOrCreateIdentity(configPath);
    const failures = failTransiently(identityFile);

    expect(await loadOrCreateIdentity(configPath)).toEqual(identity);
    expect(failures()).toBe(2);
  });

  it('rejects on an unparseable file, leaving it for recovery', async () => {
    const torn = '{"publicKey":"MCow';
    await writeFile(identityFile, torn);

    await expect(loadOrCreateIdentity(configPath)).rejects.toThrow('peer-identity.json');
    expect(await fsActual.readFile(identityFile, 'utf-8')).toBe(torn);
  });

  it('rejects on a file missing its keys, leaving it for recovery', async () => {
    const partial = JSON.stringify({ publicKey: 'pub' });
    await writeFile(identityFile, partial);

    await expect(loadOrCreateIdentity(configPath)).rejects.toThrow('peer-identity.json');
    expect(await fsActual.readFile(identityFile, 'utf-8')).toBe(partial);
  });
});

describe('loadOrCreateSharingSecret', () => {
  it('creates a secret on first use and keeps it across loads', async () => {
    const first = await loadOrCreateSharingSecret(configPath);
    expect(first.psk.length).toBeGreaterThan(0);
    expect(await loadOrCreateSharingSecret(configPath)).toEqual(first);
  });

  it('gives concurrent first uses the same secret, the one on disk', async () => {
    const [a, b] = await Promise.all([loadOrCreateSharingSecret(configPath), loadOrCreateSharingSecret(configPath)]);
    expect(b).toEqual(a);
    expect(JSON.parse(await fsActual.readFile(sharingFile, 'utf-8'))).toEqual(a);
  });

  posixOnly('writes the access secret owner-only (0600)', async () => {
    await loadOrCreateSharingSecret(configPath);
    expect((await stat(sharingFile)).mode & 0o777).toBe(0o600);
  });

  it('rejects on a read failure other than a missing file, keeping the secret', async () => {
    const secret = await loadOrCreateSharingSecret(configPath);
    failReads(sharingFile, 'EIO');

    await expect(loadOrCreateSharingSecret(configPath)).rejects.toThrow('EIO');
    readFileMock.mockReset();
    expect(await loadOrCreateSharingSecret(configPath)).toEqual(secret);
  });

  it('retries a transient lock or descriptor error instead of rotating the secret', async () => {
    const secret = await loadOrCreateSharingSecret(configPath);
    const failures = failTransiently(sharingFile);

    expect(await loadOrCreateSharingSecret(configPath)).toEqual(secret);
    expect(failures()).toBe(2);
  });

  it('rejects on an unparseable file, leaving it for recovery', async () => {
    const torn = '{"psk":"abc","lab';
    await writeFile(sharingFile, torn);

    await expect(loadOrCreateSharingSecret(configPath)).rejects.toThrow('peer-sharing.json');
    expect(await fsActual.readFile(sharingFile, 'utf-8')).toBe(torn);
  });
});

describe('rotateSharingSecret', () => {
  it('replaces the secret, keeping the label', async () => {
    await writeFile(sharingFile, JSON.stringify({ psk: 'old', label: 'Finance laptop' }));
    const rotated = await rotateSharingSecret(configPath);
    expect(rotated.psk).not.toBe('old');
    expect(rotated.label).toBe('Finance laptop');
    expect(await loadOrCreateSharingSecret(configPath)).toEqual(rotated);
  });

  it('recovers an unparseable file: it replaces the secret anyway, under the default label', async () => {
    await writeFile(sharingFile, '{"psk":"abc","lab');
    const rotated = await rotateSharingSecret(configPath);
    expect(await loadOrCreateSharingSecret(configPath)).toEqual(rotated);
  });

  it('rejects on a read failure other than a missing file, rather than dropping the label', async () => {
    const text = JSON.stringify({ psk: 'old', label: 'Finance laptop' });
    await writeFile(sharingFile, text);
    failReads(sharingFile, 'EIO');

    await expect(rotateSharingSecret(configPath)).rejects.toThrow('EIO');
    expect(await fsActual.readFile(sharingFile, 'utf-8')).toBe(text);
  });

  posixOnly('leaves a previously 0644 file at 0600', async () => {
    await writeFile(sharingFile, JSON.stringify({ psk: 'old', label: 'x' }));
    await chmod(sharingFile, 0o644);
    await rotateSharingSecret(configPath);
    expect((await stat(sharingFile)).mode & 0o777).toBe(0o600);
  });
});
