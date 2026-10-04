import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateIdentity, loadOrCreateSharingSecret, rotateSharingSecret } from '../main/handlers/peer-store.js';

let dir: string;
let configPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-peer-store-'));
  configPath = join(dir, 'costgoblin.yaml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

// POSIX permission bits don't exist on Windows (Node's chmod only toggles the
// read-only flag), so the mode assertions are POSIX-only.
const posixOnly = it.skipIf(process.platform === 'win32');

// writeFileSync's `mode` applies only when it creates the file, so a secret
// file loosened outside the app (a restore, a copy under umask 022) kept its
// mode through every later write — including a freshly rotated secret.
describe('peer secret files stay owner-only', () => {
  posixOnly('a rotated sharing secret leaves a previously 0644 file at 0600', async () => {
    const file = join(dir, 'peer-sharing.json');
    await writeFile(file, JSON.stringify({ psk: 'old', label: 'x' }));
    await chmod(file, 0o644);
    rotateSharingSecret(configPath);
    expect(await fileMode(file)).toBe(0o600);
  });

  posixOnly('loading an existing sharing secret tightens a 0644 file', async () => {
    const file = join(dir, 'peer-sharing.json');
    await writeFile(file, JSON.stringify({ psk: 'kept', label: 'x' }));
    await chmod(file, 0o644);
    expect(loadOrCreateSharingSecret(configPath).psk).toBe('kept');
    expect(await fileMode(file)).toBe(0o600);
  });

  posixOnly('loading an existing identity tightens a 0644 file', async () => {
    const first = loadOrCreateIdentity(configPath);
    const file = join(dir, 'peer-identity.json');
    await chmod(file, 0o644);
    expect(loadOrCreateIdentity(configPath)).toEqual(first);
    expect(await fileMode(file)).toBe(0o600);
  });
});
