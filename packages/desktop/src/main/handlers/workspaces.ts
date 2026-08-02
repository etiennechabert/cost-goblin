import { app as electronApp, ipcMain } from 'electron';
import { join } from 'node:path';
import { isStringRecord, logger, parseWorkspaceName } from '@costgoblin/core';
import type { CreateWorkspaceSource, WorkspaceName, WorkspacesInfo, WorkspaceSummary } from '@costgoblin/core';
import {
  createWorkspaceDirs,
  deleteWorkspaceDir,
  listWorkspaceNames,
  readAppStateSync,
  renameWorkspaceDir,
  workspacePaths,
  workspaceSizeBytes,
} from '../workspace-env.js';
import type { WorkspaceEnv } from '../workspace-env.js';
import { applyBundleSectionsToDisk } from './bundle-io.js';
import type { ConfigFilePaths } from './bundle-io.js';
import type { AppContext } from './context.js';
import { updatePrefsFile } from './prefs-file.js';
import { POST_SETUP_FLAG } from './setup.js';

/** The five canonical config YAML file names, keyed by the IpcContext path that
 *  serves each in the ACTIVE workspace (per-file env overrides never apply here
 *  because workspace management is disabled in pinned mode). */
const CONFIG_FILE_NAMES = ['costgoblin', 'dimensions', 'org-tree', 'views', 'cost-scope'] as const;

function targetConfigPaths(configDir: string): ConfigFilePaths {
  return {
    configPath: join(configDir, 'costgoblin.yaml'),
    dimensionsPath: join(configDir, 'dimensions.yaml'),
    orgTreePath: join(configDir, 'org-tree.yaml'),
    viewsPath: join(configDir, 'views.yaml'),
    costScopePath: join(configDir, 'cost-scope.yaml'),
  };
}

export function registerWorkspacesHandlers(app: AppContext): void {
  const { ctx } = app;
  const env: WorkspaceEnv = ctx.workspaceEnv;

  async function buildInfo(): Promise<WorkspacesInfo> {
    if (env.mode === 'pinned') return { mode: 'pinned', active: null, workspaces: [] };
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const names = await listWorkspaceNames(env.workspacesRoot);
    const appState = readAppStateSync(env.appStatePath);
    const workspaces: WorkspaceSummary[] = [];
    for (const name of names) {
      const root = path.join(env.workspacesRoot, name);
      let configured = false;
      try {
        await fs.access(path.join(root, 'config', 'costgoblin.yaml'));
        configured = true;
      } catch { /* not set up yet */ }
      let sizeBytes: number | null = null;
      try {
        sizeBytes = await workspaceSizeBytes(root);
      } catch { /* size is a nicety — skip on failure */ }
      workspaces.push({
        name,
        active: name === env.name,
        configured,
        sizeBytes,
        lastUsedAt: appState.lastUsed?.[name] ?? null,
      });
    }
    workspaces.sort((a, b) => (a.active === b.active ? a.name.localeCompare(b.name) : a.active ? -1 : 1));
    return { mode: 'workspace', active: env.name, workspaces };
  }

  function relaunch(postSetup: boolean): void {
    // Under e2e a relaunched instance would detach from Playwright and outlive
    // the test session — just quit; the test asserts the persisted app-state.
    if (process.env['COSTGOBLIN_E2E'] !== '1') {
      const args = process.argv.slice(1).filter((a) => a !== POST_SETUP_FLAG);
      if (postSetup) args.push(POST_SETUP_FLAG);
      electronApp.relaunch({ args });
    }
    electronApp.quit();
  }

  /** Persist `name` as last-used (stamping lastUsed) then restart into it. */
  async function relaunchInto(appStatePath: string, name: WorkspaceName, postSetup: boolean): Promise<void> {
    await updatePrefsFile(appStatePath, (current) => ({
      ...current,
      schemaVersion: 1,
      lastWorkspace: name,
      lastUsed: {
        ...(isStringRecord(current['lastUsed']) ? current['lastUsed'] : {}),
        [name]: new Date().toISOString(),
      },
    }));
    relaunch(postSetup);
  }

  function requireWorkspaceMode(): Extract<WorkspaceEnv, { mode: 'workspace' }> {
    if (env.mode !== 'workspace') {
      throw new Error('Workspaces are unavailable while data/config paths are pinned by environment overrides.');
    }
    return env;
  }

  ipcMain.handle('workspaces:list', (): Promise<WorkspacesInfo> => buildInfo());

  ipcMain.handle('workspaces:create', async (_event, rawName: unknown, source: unknown, switchTo: unknown): Promise<WorkspacesInfo> => {
    const ws = requireWorkspaceMode();
    const name = parseWorkspaceName(typeof rawName === 'string' ? rawName : '');
    const src = parseCreateSource(source);
    await createWorkspaceDirs(ws.workspacesRoot, name);
    try {
      if (src.kind === 'copy-config') {
        const fs = await import('node:fs/promises');
        const sources: Record<(typeof CONFIG_FILE_NAMES)[number], string> = {
          'costgoblin': ctx.configPath,
          'dimensions': ctx.dimensionsPath,
          'org-tree': ctx.orgTreePath,
          'views': ctx.viewsPath,
          'cost-scope': ctx.costScopePath,
        };
        const targetConfigDir = workspacePaths(ws.workspacesRoot, name).configBase;
        for (const fileName of CONFIG_FILE_NAMES) {
          try {
            await fs.copyFile(sources[fileName], join(targetConfigDir, `${fileName}.yaml`));
          } catch { /* optional config file absent — skip */ }
        }
      } else if (src.kind === 'bundle') {
        const targetConfigDir = workspacePaths(ws.workspacesRoot, name).configBase;
        await applyBundleSectionsToDisk(targetConfigPaths(targetConfigDir), src.content, src.awsProfile);
      }
    } catch (err) {
      // Creation failed midway — remove the half-built workspace so a retry
      // with the same name doesn't hit the duplicate guard.
      await deleteWorkspaceDir(ws.workspacesRoot, name).catch(() => undefined);
      throw err;
    }
    logger.info(`Workspace created: ${name} (${src.kind})`);
    if (switchTo === true) {
      await relaunchInto(ws.appStatePath, name, false);
    }
    return buildInfo();
  });

  ipcMain.handle('workspaces:rename', async (_event, rawFrom: unknown, rawTo: unknown): Promise<WorkspacesInfo> => {
    const ws = requireWorkspaceMode();
    const from = parseWorkspaceName(typeof rawFrom === 'string' ? rawFrom : '');
    const to = parseWorkspaceName(typeof rawTo === 'string' ? rawTo : '');
    await renameWorkspaceDir(ws.workspacesRoot, from, to);
    await updatePrefsFile(ws.appStatePath, (current) => moveLastUsedKey(current, from, to));
    logger.info(`Workspace renamed: ${from} -> ${to}`);
    if (from === ws.name) {
      // The running process's services still point at the old directory —
      // restart into the renamed workspace immediately.
      await relaunchInto(ws.appStatePath, to, false);
    }
    return buildInfo();
  });

  ipcMain.handle('workspaces:delete', async (_event, rawName: unknown): Promise<WorkspacesInfo> => {
    const ws = requireWorkspaceMode();
    const name = parseWorkspaceName(typeof rawName === 'string' ? rawName : '');
    if (name === ws.name) {
      throw new Error('Cannot delete the active workspace — switch to another workspace first.');
    }
    const names = await listWorkspaceNames(ws.workspacesRoot);
    if (!names.includes(name)) throw new Error(`Workspace "${name}" does not exist.`);
    if (names.length <= 1) throw new Error('Cannot delete the last workspace.');
    await deleteWorkspaceDir(ws.workspacesRoot, name);
    await updatePrefsFile(ws.appStatePath, (current) => moveLastUsedKey(current, name, null));
    logger.info(`Workspace deleted: ${name}`);
    return buildInfo();
  });

  ipcMain.handle('workspaces:switch', async (_event, rawName: unknown): Promise<void> => {
    const ws = requireWorkspaceMode();
    const name = parseWorkspaceName(typeof rawName === 'string' ? rawName : '');
    const names = await listWorkspaceNames(ws.workspacesRoot);
    if (!names.includes(name)) throw new Error(`Workspace "${name}" does not exist.`);
    await relaunchInto(ws.appStatePath, name, false);
  });

  // Setup-wizard completion. Optionally claims a user-chosen name for the
  // initial workspace (directory renamed just before the restart the wizard
  // already performs), then relaunches with the post-setup flag so the next
  // launch resumes on the data-sync screen.
  ipcMain.handle('workspaces:complete-setup', async (_event, rawName: unknown): Promise<void> => {
    if (env.mode !== 'workspace' || rawName === null) {
      relaunch(true);
      return;
    }
    const name = parseWorkspaceName(typeof rawName === 'string' ? rawName : '');
    if (name === env.name) {
      relaunch(true);
      return;
    }
    await renameWorkspaceDir(env.workspacesRoot, env.name, name);
    await updatePrefsFile(env.appStatePath, (current) => moveLastUsedKey(current, env.name, name));
    logger.info(`Workspace claimed name at setup completion: ${env.name} -> ${name}`);
    await relaunchInto(env.appStatePath, name, true);
  });
}

/** Move (or with `to: null`, drop) a workspace's lastUsed entry, and retarget
 *  lastWorkspace when it pointed at `from`. */
function moveLastUsedKey(
  current: Readonly<Record<string, unknown>>,
  from: string,
  to: string | null,
): Record<string, unknown> {
  const lastUsedRaw = current['lastUsed'];
  const lastUsed: Record<string, unknown> = {};
  if (isStringRecord(lastUsedRaw)) {
    for (const [key, value] of Object.entries(lastUsedRaw)) {
      if (key !== from) lastUsed[key] = value;
    }
  }
  const stamp = isStringRecord(lastUsedRaw) ? lastUsedRaw[from] : undefined;
  if (to !== null && stamp !== undefined) lastUsed[to] = stamp;
  const next: Record<string, unknown> = { ...current, schemaVersion: 1, lastUsed };
  if (current['lastWorkspace'] === from && to !== null) next['lastWorkspace'] = to;
  return next;
}

function parseCreateSource(source: unknown): CreateWorkspaceSource {
  if (isStringRecord(source)) {
    const kind = source['kind'];
    if (kind === 'fresh') return { kind: 'fresh' };
    if (kind === 'copy-config') return { kind: 'copy-config' };
    if (kind === 'bundle') {
      const content = source['content'];
      const awsProfile = source['awsProfile'];
      if (typeof content === 'string' && typeof awsProfile === 'string') {
        return { kind: 'bundle', content, awsProfile };
      }
    }
  }
  throw new Error('Invalid workspace creation source.');
}
