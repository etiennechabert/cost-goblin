import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findGhCli, findGitCli } from '@costgoblin/core';
import { registerDebugHandlers } from '../main/handlers/debug.js';
import { electronAppState, resetElectronFakes } from './helpers/electron-fake.js';
import { at, createHarness, list, type Harness } from './helpers/ipc-harness.js';

/** The debug panel's IPC channels: the query log (list, EXPLAIN, clear), the
 *  rollup readiness probe, memory, and the dev-only git branch / PR labels.
 *  git and gh are faked at `execFile` — the handlers resolve them through the
 *  trusted-binary lookup, which is faked too. */

const exec = vi.hoisted(() => ({
  run: vi.fn<(file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>>(),
}));

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);
vi.mock('@costgoblin/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@costgoblin/core')>();
  return { ...actual, findGitCli: vi.fn(() => '/usr/bin/git'), findGhCli: vi.fn(() => '/usr/local/bin/gh') };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  // debug.ts promisifies execFile at import; the custom hook is what
  // `promisify` returns, resolving `{ stdout, stderr }` like the real one.
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: (file: string, args: readonly string[]) => exec.run(file, args),
  });
  return { ...actual, execFile };
});

const harnesses: Harness[] = [];

beforeEach(() => {
  resetElectronFakes();
  exec.run.mockReset();
  vi.mocked(findGitCli).mockReturnValue('/usr/bin/git');
  vi.mocked(findGhCli).mockReturnValue('/usr/local/bin/gh');
});

afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.dispose();
});

async function debugApp(): Promise<Harness> {
  const h = await createHarness({ config: 'none' });
  registerDebugHandlers(h.app);
  harnesses.push(h);
  return h;
}

describe('query log', () => {
  it('lists, explains and clears logged queries', async () => {
    const h = await debugApp();
    await h.app.runPreparedQuery('SELECT $1::INTEGER AS v', [5]);
    const entries = list(await h.ipc.invoke('debug:get-query-log'));
    expect(entries).toHaveLength(1);
    const id = at(entries[0], 'id');

    const plan = await h.ipc.invoke('debug:run-explain', id);
    expect(typeof plan).toBe('string');
    expect(String(plan)).toMatch(/\S/);
    expect(h.db.statements.at(-1)).toBe('EXPLAIN ANALYZE SELECT $1::INTEGER AS v');
    expect(await h.ipc.invoke('debug:run-explain', 9999)).toBe('Query not found in log');

    await h.ipc.invoke('debug:clear-completed');
    expect(list(await h.ipc.invoke('debug:get-query-log')).every(e => at(e, 'status') !== 'success')).toBe(true);
    await h.app.runPreparedQuery('SELECT 1 AS one', []);
    await h.ipc.invoke('debug:clear-query-log');
    expect(await h.ipc.invoke('debug:get-query-log')).toEqual([]);
  });

  it('reports rollup readiness and memory use', async () => {
    const h = await debugApp();
    expect(await h.ipc.invoke('debug:materialized-status')).toEqual({ ready: false, validPeriods: [] });
    const rss = await h.ipc.invoke('debug:get-memory-mb');
    expect(typeof rss).toBe('number');
    expect(Number(rss)).toBeGreaterThan(0);
  });
});

describe('debug:get-git-branch', () => {
  it('names the checked-out branch from the app directory', async () => {
    const h = await debugApp();
    exec.run.mockResolvedValueOnce({ stdout: 'feature/coverage\n', stderr: '' });
    expect(await h.ipc.invoke('debug:get-git-branch')).toBe('feature/coverage');
    expect(exec.run).toHaveBeenCalledWith('/usr/bin/git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  });

  it('is null when packaged, without git, on a detached or empty HEAD, or when git fails', async () => {
    const h = await debugApp();
    exec.run.mockResolvedValueOnce({ stdout: 'HEAD\n', stderr: '' });
    expect(await h.ipc.invoke('debug:get-git-branch')).toBeNull();
    exec.run.mockResolvedValueOnce({ stdout: '\n', stderr: '' });
    expect(await h.ipc.invoke('debug:get-git-branch')).toBeNull();
    exec.run.mockRejectedValueOnce(new Error('fatal: not a git repository'));
    expect(await h.ipc.invoke('debug:get-git-branch')).toBeNull();
    vi.mocked(findGitCli).mockReturnValueOnce(null);
    expect(await h.ipc.invoke('debug:get-git-branch')).toBeNull();
    electronAppState.isPackaged = true;
    expect(await h.ipc.invoke('debug:get-git-branch')).toBeNull();
    expect(exec.run).toHaveBeenCalledTimes(3);
  });
});

describe('debug:get-branch-pr', () => {
  const pr = (fields: Record<string, unknown>): { stdout: string; stderr: string } => ({ stdout: JSON.stringify(fields), stderr: '' });

  it('returns the branch PR gh reports', async () => {
    const h = await debugApp();
    exec.run.mockResolvedValueOnce(pr({ url: 'https://github.com/o/r/pull/7', title: 'Raise coverage', number: 7 }));
    expect(await h.ipc.invoke('debug:get-branch-pr')).toEqual({ url: 'https://github.com/o/r/pull/7', title: 'Raise coverage', number: 7 });
    expect(exec.run).toHaveBeenCalledWith('/usr/local/bin/gh', ['pr', 'view', '--json', 'url,title,number']);
  });

  it('is null for anything that is not a well-formed https PR record', async () => {
    const h = await debugApp();
    for (const out of [
      pr({ url: 'javascript:alert(1)', title: 't', number: 1 }),
      pr({ url: 42, title: 't', number: 1 }),
      pr({ url: 'https://github.com/o/r/pull/1', title: null, number: 1 }),
      pr({ url: 'https://github.com/o/r/pull/1', title: 't', number: '1' }),
      { stdout: 'no pull requests found', stderr: '' },
    ]) {
      exec.run.mockResolvedValueOnce(out);
      expect(await h.ipc.invoke('debug:get-branch-pr')).toBeNull();
    }
    exec.run.mockRejectedValueOnce(new Error('gh: not logged in'));
    expect(await h.ipc.invoke('debug:get-branch-pr')).toBeNull();
  });

  it('is null when packaged or without gh', async () => {
    const h = await debugApp();
    vi.mocked(findGhCli).mockReturnValueOnce(null);
    expect(await h.ipc.invoke('debug:get-branch-pr')).toBeNull();
    electronAppState.isPackaged = true;
    expect(await h.ipc.invoke('debug:get-branch-pr')).toBeNull();
    expect(exec.run).not.toHaveBeenCalled();
  });
});
