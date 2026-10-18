import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWorkspaceName, serializeConfigBundle } from '@costgoblin/core';
import { buildCurrentBundle } from '../main/handlers/bundle-io.js';
import { POST_SETUP_FLAG } from '../main/handlers/setup.js';
import { registerWorkspacesHandlers } from '../main/handlers/workspaces.js';
import { createWorkspaceDirs, workspacePaths } from '../main/workspace-env.js';
import { app as electronApp, resetElectronFakes } from './helpers/electron-fake.js';
import { at, createHarness, list, type Harness, type TestWorkspace } from './helpers/ipc-harness.js';
import type { IpcContext } from '../main/handlers/context.js';

/** Workspace management over IPC: listing, create (fresh / copy / bundle,
 *  with cleanup on failure), rename (deferred for the active one), delete
 *  guards, switch and setup completion — all of which persist app-state.json
 *  and relaunch. Runs in workspace mode over a throwaway workspaces root;
 *  `app.relaunch` / `app.quit` are recorded, never executed. */

vi.mock('electron', async () => (await import('./helpers/electron-fake.js')).fakeElectronModule);
vi.mock('@sentry/electron/main', async () => (await import('./helpers/electron-fake.js')).fakeSentryModule);

const ACTIVE = parseWorkspaceName('default');
const CONFIG_FILES = ['cost-scope.yaml', 'costgoblin.yaml', 'dimensions.yaml', 'org-tree.yaml', 'views.yaml'];

interface WorkspaceApp {
  readonly h: Harness;
  readonly root: string;
  readonly appStatePath: string;
}

const harnesses: Harness[] = [];

beforeEach(() => {
  resetElectronFakes();
  vi.stubEnv('COSTGOBLIN_E2E', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const h of harnesses.splice(0)) await h.dispose();
});

function workspaceContext(ws: TestWorkspace): Partial<IpcContext> {
  const workspacesRoot = join(ws.root, 'workspaces');
  const paths = workspacePaths(workspacesRoot, ACTIVE);
  return {
    configPath: join(paths.configBase, 'costgoblin.yaml'),
    dimensionsPath: join(paths.configBase, 'dimensions.yaml'),
    orgTreePath: join(paths.configBase, 'org-tree.yaml'),
    viewsPath: join(paths.configBase, 'views.yaml'),
    costScopePath: join(paths.configBase, 'cost-scope.yaml'),
    dataDir: paths.dataDir,
    stateDir: paths.stateDir,
    workspaceEnv: { mode: 'workspace', name: ACTIVE, workspacesRoot, appStatePath: join(ws.root, 'app-state.json'), ...paths },
  };
}

/** Workspace mode with an active, configured "default" workspace (a copy of
 *  the fixture config) plus the named extra workspaces. */
async function workspaceApp(others: readonly string[] = []): Promise<WorkspaceApp> {
  const h = await createHarness({ config: 'single', overrides: workspaceContext });
  harnesses.push(h);
  const root = join(h.ws.root, 'workspaces');
  await createWorkspaceDirs(root, ACTIVE);
  for (const file of CONFIG_FILES) await copyFile(join(h.ws.configDir, file), join(root, ACTIVE, 'config', file));
  for (const name of others) await createWorkspaceDirs(root, parseWorkspaceName(name));
  registerWorkspacesHandlers(h.app);
  return { h, root, appStatePath: join(h.ws.root, 'app-state.json') };
}

async function appState(w: WorkspaceApp): Promise<unknown> {
  return JSON.parse(await readFile(w.appStatePath, 'utf-8'));
}

function names(info: unknown): unknown[] {
  return list(at(info, 'workspaces')).map(w => at(w, 'name'));
}

describe('pinned mode', () => {
  it('lists nothing and refuses every workspace operation', async () => {
    const h = await createHarness({ config: 'single' });
    harnesses.push(h);
    registerWorkspacesHandlers(h.app);
    expect(await h.ipc.invoke('workspaces:list')).toEqual({ mode: 'pinned', active: null, workspaces: [] });
    for (const [channel, args] of [
      ['workspaces:create', ['x', { kind: 'fresh' }, false]],
      ['workspaces:rename', ['a', 'b']],
      ['workspaces:delete', ['a']],
      ['workspaces:switch', ['a']],
    ] as const) {
      await expect(h.ipc.invoke(channel, ...args)).rejects.toThrow('Workspaces are unavailable while data/config paths are pinned');
    }
  });

  it('completing setup just relaunches with the post-setup flag', async () => {
    const h = await createHarness({ config: 'single' });
    harnesses.push(h);
    registerWorkspacesHandlers(h.app);
    await h.ipc.invoke('workspaces:complete-setup', 'ignored');
    expect(electronApp.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining([POST_SETUP_FLAG]) });
    expect(electronApp.quit).toHaveBeenCalledTimes(1);
  });
});

describe('workspaces:list', () => {
  it('lists the active workspace first, then the rest A→Z, with setup state, size and last use', async () => {
    const w = await workspaceApp(['zeta', 'alpha']);
    await writeFile(w.appStatePath, JSON.stringify({ lastUsed: { alpha: '2026-02-01T00:00:00.000Z', default: 7 } }));
    await writeFile(join(w.root, 'stray-file.txt'), 'ignored');
    const info = await w.h.ipc.invoke('workspaces:list');
    expect(at(info, 'mode')).toBe('workspace');
    expect(at(info, 'active')).toBe('default');
    expect(names(info)).toEqual(['default', 'alpha', 'zeta']);
    expect(at(info, 'workspaces', 0)).toMatchObject({ active: true, configured: true, lastUsedAt: null });
    expect(at(info, 'workspaces', 1)).toMatchObject({ active: false, configured: false, sizeBytes: 0, lastUsedAt: '2026-02-01T00:00:00.000Z' });
    expect(Number(at(info, 'workspaces', 0, 'sizeBytes'))).toBeGreaterThan(0);
  });
});

describe('workspaces:create', () => {
  it('creates a fresh workspace skeleton', async () => {
    const w = await workspaceApp();
    const info = await w.h.ipc.invoke('workspaces:create', 'scratch', { kind: 'fresh' }, false);
    expect(names(info)).toEqual(['default', 'scratch']);
    expect((await readdir(join(w.root, 'scratch'))).sort()).toEqual(['config', 'data', 'state', 'temp']);
    expect(electronApp.relaunch).not.toHaveBeenCalled();
  });

  it('copies the active config files that exist', async () => {
    const w = await workspaceApp();
    await rm(join(w.root, ACTIVE, 'config', 'views.yaml'));
    await w.h.ipc.invoke('workspaces:create', 'copy', { kind: 'copy-config' }, false);
    expect((await readdir(join(w.root, 'copy', 'config'))).sort()).toEqual(CONFIG_FILES.filter(f => f !== 'views.yaml'));
    expect(at(await w.h.ipc.invoke('workspaces:list'), 'workspaces', 1, 'configured')).toBe(true);
  });

  it('applies a bundle into the new workspace with the chosen profile', async () => {
    const w = await workspaceApp();
    const content = serializeConfigBundle(await buildCurrentBundle(w.h.app, { brokenViews: 'fail' }));
    await w.h.ipc.invoke('workspaces:create', 'imported', { kind: 'bundle', content, awsProfile: 'team-sso' }, false);
    expect(await readFile(join(w.root, 'imported', 'config', 'costgoblin.yaml'), 'utf-8')).toContain('credentialsProfile: team-sso');
  });

  it('removes a half-built workspace when the bundle is bad, so a retry can reuse the name', async () => {
    const w = await workspaceApp();
    await expect(w.h.ipc.invoke('workspaces:create', 'imported', { kind: 'bundle', content: 'kind: nope\n', awsProfile: 'p' }, false)).rejects.toThrow();
    expect(await readdir(w.root)).toEqual(['default']);
    await expect(w.h.ipc.invoke('workspaces:create', 'imported', { kind: 'fresh' }, false)).resolves.toBeDefined();
  });

  it('switches into the new workspace when asked', async () => {
    const w = await workspaceApp();
    await w.h.ipc.invoke('workspaces:create', 'next', { kind: 'fresh' }, true);
    expect(await appState(w)).toMatchObject({ schemaVersion: 1, lastWorkspace: 'next', lastUsed: { next: expect.any(String) } });
    expect(electronApp.relaunch).toHaveBeenCalledTimes(1);
    expect(electronApp.quit).toHaveBeenCalledTimes(1);
  });

  it('refuses an invalid source, name or duplicate before creating anything', async () => {
    const w = await workspaceApp(['taken']);
    for (const source of [null, { kind: 'mystery' }, { kind: 'bundle', content: 'x' }, 'fresh']) {
      await expect(w.h.ipc.invoke('workspaces:create', 'new-one', source, false)).rejects.toThrow('Invalid workspace creation source.');
    }
    await expect(w.h.ipc.invoke('workspaces:create', 42, { kind: 'fresh' }, false)).rejects.toThrow('Workspace name cannot be empty.');
    await expect(w.h.ipc.invoke('workspaces:create', 'TAKEN', { kind: 'fresh' }, false)).rejects.toThrow('A workspace named "taken" already exists.');
    expect((await readdir(w.root)).sort()).toEqual(['default', 'taken']);
  });
});

describe('workspaces:rename', () => {
  it('renames another workspace in place, carrying its last-used stamp and the last-workspace pointer', async () => {
    const w = await workspaceApp(['old']);
    await writeFile(w.appStatePath, JSON.stringify({ lastWorkspace: 'old', lastUsed: { old: '2026-01-01T00:00:00.000Z', default: '2026-02-01T00:00:00.000Z' } }));
    const info = await w.h.ipc.invoke('workspaces:rename', 'old', 'new');
    expect(names(info)).toEqual(['default', 'new']);
    expect(await appState(w)).toEqual({
      schemaVersion: 1,
      lastWorkspace: 'new',
      lastUsed: { default: '2026-02-01T00:00:00.000Z', new: '2026-01-01T00:00:00.000Z' },
    });
    expect(electronApp.relaunch).not.toHaveBeenCalled();
  });

  it('copes with app-state that has no usable last-used map', async () => {
    const w = await workspaceApp(['old']);
    await writeFile(w.appStatePath, JSON.stringify({ lastUsed: 'corrupt', lastWorkspace: 'default' }));
    await w.h.ipc.invoke('workspaces:rename', 'old', 'renamed');
    expect(await appState(w)).toEqual({ schemaVersion: 1, lastWorkspace: 'default', lastUsed: {} });
  });

  it('defers renaming the active workspace to the next launch and relaunches', async () => {
    const w = await workspaceApp();
    await w.h.ipc.invoke('workspaces:rename', 'default', 'main');
    expect(await readdir(w.root)).toEqual(['default']);
    expect(await appState(w)).toMatchObject({ lastWorkspace: 'main', pendingRename: { from: 'default', to: 'main' }, lastUsed: { main: expect.any(String) } });
    expect(electronApp.relaunch).toHaveBeenCalledWith({ args: expect.not.arrayContaining([POST_SETUP_FLAG]) });
  });

  it('treats a non-string name from the renderer as no name', async () => {
    const w = await workspaceApp(['other']);
    await expect(w.h.ipc.invoke('workspaces:rename', 42, 'x')).rejects.toThrow('Workspace name cannot be empty.');
    await expect(w.h.ipc.invoke('workspaces:rename', 'other', null)).rejects.toThrow('Workspace name cannot be empty.');
    await expect(w.h.ipc.invoke('workspaces:delete', {})).rejects.toThrow('Workspace name cannot be empty.');
    await expect(w.h.ipc.invoke('workspaces:switch', undefined)).rejects.toThrow('Workspace name cannot be empty.');
  });

  it('refuses a rename onto an existing name', async () => {
    const w = await workspaceApp(['other']);
    await expect(w.h.ipc.invoke('workspaces:rename', 'default', 'Other')).rejects.toThrow('A workspace named "other" already exists.');
    await expect(w.h.ipc.invoke('workspaces:rename', 'other', 'DEFAULT')).rejects.toThrow('A workspace named "default" already exists.');
    expect(electronApp.relaunch).not.toHaveBeenCalled();
  });
});

describe('workspaces:delete and workspaces:switch', () => {
  it('deletes another workspace and forgets its last use', async () => {
    const w = await workspaceApp(['gone']);
    await writeFile(w.appStatePath, JSON.stringify({ lastUsed: { gone: '2026-01-01T00:00:00.000Z' } }));
    expect(names(await w.h.ipc.invoke('workspaces:delete', 'gone'))).toEqual(['default']);
    expect(await readdir(w.root)).toEqual(['default']);
    expect(await appState(w)).toEqual({ schemaVersion: 1, lastUsed: {} });
  });

  it('never deletes the active, a missing or the last workspace', async () => {
    const w = await workspaceApp(['spare']);
    await expect(w.h.ipc.invoke('workspaces:delete', 'default')).rejects.toThrow('Cannot delete the active workspace');
    await expect(w.h.ipc.invoke('workspaces:delete', 'nope')).rejects.toThrow('Workspace "nope" does not exist.');
    expect((await readdir(w.root)).sort()).toEqual(['default', 'spare']);
  });

  it('switches only into an existing workspace, without the post-setup flag', async () => {
    const w = await workspaceApp(['spare']);
    await writeFile(w.appStatePath, JSON.stringify({ theme: 'light', lastUsed: { default: '2026-02-01T00:00:00.000Z' } }));
    await expect(w.h.ipc.invoke('workspaces:switch', 'nope')).rejects.toThrow('Workspace "nope" does not exist.');
    await w.h.ipc.invoke('workspaces:switch', 'spare');
    expect(await appState(w)).toMatchObject({
      theme: 'light',
      lastWorkspace: 'spare',
      lastUsed: { default: '2026-02-01T00:00:00.000Z', spare: expect.any(String) },
    });
    const args = electronApp.relaunch.mock.calls[0]?.[0]?.args ?? [];
    expect(args).not.toContain(POST_SETUP_FLAG);
  });

  it('only quits under e2e, where a relaunched instance would outlive the test', async () => {
    vi.stubEnv('COSTGOBLIN_E2E', '1');
    const w = await workspaceApp(['spare']);
    await w.h.ipc.invoke('workspaces:switch', 'spare');
    expect(electronApp.relaunch).not.toHaveBeenCalled();
    expect(electronApp.quit).toHaveBeenCalledTimes(1);
  });
});

describe('workspaces:complete-setup', () => {
  it('relaunches into the post-setup screen when no new name is claimed', async () => {
    const w = await workspaceApp();
    await w.h.ipc.invoke('workspaces:complete-setup', null);
    await w.h.ipc.invoke('workspaces:complete-setup', 'default');
    expect(electronApp.relaunch).toHaveBeenCalledTimes(2);
    expect(electronApp.relaunch).toHaveBeenLastCalledWith({ args: expect.arrayContaining([POST_SETUP_FLAG]) });
    await expect(readFile(w.appStatePath, 'utf-8')).rejects.toThrow();
  });

  it('claims a new name for the initial workspace through a deferred rename', async () => {
    const w = await workspaceApp();
    await mkdir(join(w.root, 'unrelated-dir-with space'));
    await w.h.ipc.invoke('workspaces:complete-setup', 'finance');
    expect(await appState(w)).toMatchObject({ lastWorkspace: 'finance', pendingRename: { from: 'default', to: 'finance' } });
    expect(electronApp.relaunch).toHaveBeenCalledWith({ args: expect.arrayContaining([POST_SETUP_FLAG]) });
  });

  it('refuses a name that is invalid or already taken', async () => {
    const w = await workspaceApp(['finance']);
    await expect(w.h.ipc.invoke('workspaces:complete-setup', 'Finance')).rejects.toThrow('A workspace named "finance" already exists.');
    await expect(w.h.ipc.invoke('workspaces:complete-setup', 17)).rejects.toThrow('Workspace name cannot be empty.');
    expect(electronApp.relaunch).not.toHaveBeenCalled();
  });
});
