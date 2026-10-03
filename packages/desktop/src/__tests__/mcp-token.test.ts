import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_MIN_TOKEN_LENGTH } from '@costgoblin/mcp';
import { loadOrCreateMcpToken, regenerateMcpToken } from '../main/mcp-token.js';

// Pass-through fs so a case can inject a failure into one read; the token is
// read through @costgoblin/core's atomic-file module, which imports this one.
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
let tokenFile: string;

beforeEach(async () => {
  // Canonical (macOS tmpdir is a symlink): writes resolve their target path.
  dir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-mcp-token-')));
  tokenFile = join(dir, 'mcp-auth-token');
});

afterEach(async () => {
  readFileMock.mockReset();
  await rm(dir, { recursive: true, force: true });
});

async function fileMode(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

// POSIX permission bits don't exist on Windows (Node's chmod only toggles the
// read-only flag), so the mode assertions are POSIX-only.
const posixOnly = it.skipIf(process.platform === 'win32');

describe('loadOrCreateMcpToken', () => {
  it('creates a token long enough for the server on first use', async () => {
    const token = await loadOrCreateMcpToken(tokenFile);
    expect(token.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(await fsActual.readFile(tokenFile, 'utf-8')).toBe(token);
    expect(await readdir(dir)).toEqual(['mcp-auth-token']);
  });

  it('is stable across loads', async () => {
    const first = await loadOrCreateMcpToken(tokenFile);
    expect(await loadOrCreateMcpToken(tokenFile)).toBe(first);
  });

  it('keeps a stored token that meets the minimum length', async () => {
    const stored = 'a'.repeat(MCP_MIN_TOKEN_LENGTH);
    await writeFile(tokenFile, `${stored}\n`);
    expect(await loadOrCreateMcpToken(tokenFile)).toBe(stored);
  });

  it('replaces a stored token that is too short for the server to start with', async () => {
    await writeFile(tokenFile, 'short');
    const token = await loadOrCreateMcpToken(tokenFile);
    expect(token).not.toBe('short');
    expect(token.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(await fsActual.readFile(tokenFile, 'utf-8')).toBe(token);
  });

  it('rejects on a read failure other than a missing file, keeping the stored token', async () => {
    const stored = 'a'.repeat(MCP_MIN_TOKEN_LENGTH);
    await writeFile(tokenFile, stored);
    readFileMock.mockImplementation((file, options) =>
      file === tokenFile ? Promise.reject(errnoError('EIO')) : fsActual.readFile(file, options));

    await expect(loadOrCreateMcpToken(tokenFile)).rejects.toThrow('EIO');
    expect(await fsActual.readFile(tokenFile, 'utf-8')).toBe(stored);
  });

  it('retries a transient lock or descriptor error instead of rotating the token', async () => {
    const stored = 'a'.repeat(MCP_MIN_TOKEN_LENGTH);
    await writeFile(tokenFile, stored);
    let failures = 0;
    readFileMock.mockImplementation((file, options) => {
      if (file === tokenFile && failures < 2) {
        failures += 1;
        return Promise.reject(errnoError(failures === 1 ? 'EBUSY' : 'EMFILE'));
      }
      return fsActual.readFile(file, options);
    });

    expect(await loadOrCreateMcpToken(tokenFile)).toBe(stored);
    expect(failures).toBe(2);
  });

  posixOnly('writes a new token file as 0600', async () => {
    await loadOrCreateMcpToken(tokenFile);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });

  posixOnly('tightens a 0644 file to 0600 when it replaces a short token', async () => {
    await writeFile(tokenFile, 'short');
    await chmod(tokenFile, 0o644);
    await loadOrCreateMcpToken(tokenFile);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });
});

describe('regenerateMcpToken', () => {
  it('writes a fresh token of at least the minimum length', async () => {
    const before = await loadOrCreateMcpToken(tokenFile);
    const after = await regenerateMcpToken(tokenFile);
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(await fsActual.readFile(tokenFile, 'utf-8')).toBe(after);
  });

  posixOnly('leaves a previously 0644 file at 0600', async () => {
    await writeFile(tokenFile, 'a'.repeat(MCP_MIN_TOKEN_LENGTH));
    await chmod(tokenFile, 0o644);
    await regenerateMcpToken(tokenFile);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });
});
