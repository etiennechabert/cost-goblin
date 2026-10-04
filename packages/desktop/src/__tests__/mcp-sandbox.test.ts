import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDuckDbSandboxStatements } from '@costgoblin/core';
import { MCP_SANDBOX_REFUSAL, mapSandboxError, prepareMcpSandbox, sandboxedQueryFns } from '../main/mcp-sandbox.js';

describe('prepareMcpSandbox', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cg-mcp-sandbox-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the granted dirs and grants only data, the MCP spill dir and the org-accounts file', () => {
    const paths = { dataDir: join(root, 'ws', 'data'), stateDir: join(root, 'ws', 'state'), tempDir: join(root, 'ws', 'tmp') };
    const opts = prepareMcpSandbox(paths);

    expect(existsSync(paths.dataDir)).toBe(true);
    expect(existsSync(join(paths.tempDir, 'mcp'))).toBe(true);
    // Canonical (on macOS mkdtemp lives under the /var -> /private/var symlink).
    const canonicalRoot = realpathSync(root);
    expect(opts.allowedDirectories).toEqual([
      join(canonicalRoot, 'ws', 'data'),
      join(canonicalRoot, 'ws', 'tmp', 'mcp'),
    ]);
    expect(opts.allowedPaths).toEqual([join(canonicalRoot, 'ws', 'state', 'org-account-tags.json')]);
    expect(opts.tempDirectory).toBe(join(canonicalRoot, 'ws', 'tmp', 'mcp'));
    // Never the whole stateDir.
    expect(opts.allowedDirectories).not.toContain(join(canonicalRoot, 'ws', 'state'));
  });

  it('caps the instance at 2GB / 4 threads and yields valid sandbox statements', () => {
    const opts = prepareMcpSandbox({ dataDir: join(root, 'd'), stateDir: join(root, 's'), tempDir: join(root, 't') });
    expect(opts.memoryLimitGB).toBeGreaterThanOrEqual(1);
    expect(opts.memoryLimitGB).toBeLessThanOrEqual(2);
    expect(Number.isInteger(opts.maxTempDirectorySizeGB) && opts.maxTempDirectorySizeGB > 0).toBe(true);
    expect(opts.threads).toBeGreaterThanOrEqual(1);
    expect(opts.threads).toBeLessThanOrEqual(4);
    expect(buildDuckDbSandboxStatements(opts).at(-1)).toBe('SET lock_configuration = true');
  });
});

describe('sandbox error mapping', () => {
  const denial = new Error('Permission Error: Cannot access file "/Users/me/.aws/credentials" - file system operations are disabled by configuration');

  it('maps a DuckDB permission error to the generic, path-free refusal', () => {
    const mapped = mapSandboxError(denial);
    expect(mapped).toBeInstanceOf(Error);
    if (mapped instanceof Error) {
      expect(mapped.message).toBe(MCP_SANDBOX_REFUSAL);
      expect(mapped.message).not.toContain('.aws');
    }
  });

  it('passes other errors through unchanged', () => {
    const other = new Error('Binder Error: column "nope" not found');
    expect(mapSandboxError(other)).toBe(other);
    expect(mapSandboxError('plain string')).toBe('plain string');
  });

  it('wraps both query functions', async () => {
    const fns = sandboxedQueryFns({
      runQuery: (sql) => (sql === 'ok' ? Promise.resolve([{ v: 1 }]) : Promise.reject(denial)),
      runPreparedQuery: (_sql, params) => (params.length === 0 ? Promise.resolve([{ v: 2 }]) : Promise.reject(denial)),
    });
    await expect(fns.runQuery('ok')).resolves.toEqual([{ v: 1 }]);
    await expect(fns.runQuery('bad')).rejects.toThrow(MCP_SANDBOX_REFUSAL);
    await expect(fns.runPreparedQuery('ok', [])).resolves.toEqual([{ v: 2 }]);
    await expect(fns.runPreparedQuery('bad', ['x'])).rejects.toThrow(MCP_SANDBOX_REFUSAL);
  });
});
