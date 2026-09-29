import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_MIN_TOKEN_LENGTH } from '@costgoblin/mcp';
import { loadOrCreateMcpToken, regenerateMcpToken } from '../main/mcp-token.js';

let dir: string;
let tokenFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-mcp-token-'));
  tokenFile = join(dir, 'mcp-auth-token');
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

describe('loadOrCreateMcpToken', () => {
  it('creates a token long enough for the server on first use', async () => {
    const token = loadOrCreateMcpToken(tokenFile);
    expect(token.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(await readFile(tokenFile, 'utf-8')).toBe(token);
  });

  it('is stable across loads', () => {
    const first = loadOrCreateMcpToken(tokenFile);
    expect(loadOrCreateMcpToken(tokenFile)).toBe(first);
  });

  it('keeps a stored token that meets the minimum length', async () => {
    const stored = 'a'.repeat(MCP_MIN_TOKEN_LENGTH);
    await writeFile(tokenFile, `${stored}\n`);
    expect(loadOrCreateMcpToken(tokenFile)).toBe(stored);
  });

  it('replaces a stored token that is too short for the server to start with', async () => {
    await writeFile(tokenFile, 'short');
    const token = loadOrCreateMcpToken(tokenFile);
    expect(token).not.toBe('short');
    expect(token.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(await readFile(tokenFile, 'utf-8')).toBe(token);
  });

  posixOnly('writes a new token file as 0600', async () => {
    loadOrCreateMcpToken(tokenFile);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });

  posixOnly('tightens a 0644 file to 0600 when it replaces a short token', async () => {
    await writeFile(tokenFile, 'short');
    await chmod(tokenFile, 0o644);
    loadOrCreateMcpToken(tokenFile);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });
});

describe('regenerateMcpToken', () => {
  it('writes a fresh token of at least the minimum length', async () => {
    const before = loadOrCreateMcpToken(tokenFile);
    const after = regenerateMcpToken(tokenFile);
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThanOrEqual(MCP_MIN_TOKEN_LENGTH);
    expect(await readFile(tokenFile, 'utf-8')).toBe(after);
  });

  posixOnly('leaves a previously 0644 file at 0600', async () => {
    await writeFile(tokenFile, 'a'.repeat(MCP_MIN_TOKEN_LENGTH));
    await chmod(tokenFile, 0o644);
    regenerateMcpToken(tokenFile);
    expect(await fileMode(tokenFile)).toBe(0o600);
  });
});
