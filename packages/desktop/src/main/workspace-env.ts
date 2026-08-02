import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_WORKSPACE_NAME, isStringRecord, isValidWorkspaceName, parseJsonObject, parseWorkspaceName } from '@costgoblin/core';
import type { WorkspaceName } from '@costgoblin/core';

/**
 * Workspace-aware path resolution for the main process (issue #518).
 *
 * Deliberately Electron-free: `resolveWorkspaceEnv` takes the userData path and
 * env as plain values so everything here is unit-testable against a mkdtemp
 * directory. Runs before `app.whenReady()` — all resolution is synchronous.
 */

export interface WorkspacePaths {
  readonly dataDir: string;
  readonly configBase: string;
  readonly stateDir: string;
  readonly tempDir: string;
}

export type WorkspaceEnv =
  | (WorkspacePaths & { readonly mode: 'pinned' })
  | (WorkspacePaths & {
      readonly mode: 'workspace';
      readonly name: WorkspaceName;
      readonly workspacesRoot: string; // {userData}/workspaces
      readonly appStatePath: string; // {userData}/app-state.json
    });

/** Machine-level state at `{userData}/app-state.json`. Theme + chart palette
 *  live here in workspace mode (they are machine prefs, not workspace prefs). */
export interface AppStateFile {
  schemaVersion?: number; // currently 1
  lastWorkspace?: string;
  lastUsed?: Record<string, string>; // name -> ISO timestamp
  theme?: 'dark' | 'light';
  palette?: 'standard' | 'colorblind';
}

const APP_STATE_SCHEMA_VERSION = 1;

/** Loose state files historically written to the userData root (state root was
 *  `dirname(dataDir)`), plus the `raw/` account-CSV fallback directory. Each
 *  moves into `workspaces/default/state/` during legacy migration. */
export const MIGRATED_STATE_ENTRIES: readonly string[] = [
  'ui-preferences.json',
  'app-preferences.json',
  'explorer-preferences.json',
  'savings-preferences.json',
  'telemetry-outbox.jsonl',
  'baselines.json',
  'baselines-data.json',
  'org-accounts.json',
  'org-account-tags.json',
  'region-names.json',
  'dismissed-suggestions.json',
  'raw',
];

const WORKSPACE_SUBDIRS: readonly string[] = ['config', 'data', 'state', 'temp'];

export function workspacePaths(workspacesRoot: string, name: WorkspaceName): WorkspacePaths {
  const root = join(workspacesRoot, name);
  return {
    dataDir: join(root, 'data'),
    configBase: join(root, 'config'),
    stateDir: join(root, 'state'),
    tempDir: join(root, 'temp'),
  };
}

/** Tolerant read of app-state.json: a missing file, unreadable JSON, or wrong
 *  field shapes yield `{}` (or the salvageable subset) — never a throw. */
export function readAppStateSync(appStatePath: string): AppStateFile {
  let raw: string;
  try {
    raw = readFileSync(appStatePath, 'utf-8');
  } catch {
    return {};
  }
  const parsed = parseJsonObject(raw);
  if (parsed === null) return {};

  const state: AppStateFile = {};
  const schemaVersion = parsed['schemaVersion'];
  if (typeof schemaVersion === 'number') state.schemaVersion = schemaVersion;
  const lastWorkspace = parsed['lastWorkspace'];
  if (typeof lastWorkspace === 'string') state.lastWorkspace = lastWorkspace;
  const lastUsed = parsed['lastUsed'];
  if (isStringRecord(lastUsed)) {
    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(lastUsed)) {
      if (typeof value === 'string') entries[key] = value;
    }
    state.lastUsed = entries;
  }
  const theme = parsed['theme'];
  if (theme === 'dark' || theme === 'light') state.theme = theme;
  const palette = parsed['palette'];
  if (palette === 'standard' || palette === 'colorblind') state.palette = palette;
  return state;
}

/** Atomic write of app-state.json: write a temp file in the same directory,
 *  then rename over the destination so readers never observe a torn file. */
export function writeAppStateSync(appStatePath: string, state: AppStateFile): void {
  const dir = dirname(appStatePath);
  mkdirSync(dir, { recursive: true });
  const tempPath = join(dir, `.app-state.${String(process.pid)}.${String(Date.now())}.tmp`);
  writeFileSync(tempPath, JSON.stringify(state, null, 2));
  renameSync(tempPath, appStatePath);
}

function isDirectorySync(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the pre-workspace single-workspace layout is present at the
 *  userData root: a config YAML, a data dir, or any loose legacy state file. */
function hasLegacyLayoutSync(userDataPath: string): boolean {
  if (existsSync(join(userDataPath, 'config', 'costgoblin.yaml'))) return true;
  if (existsSync(join(userDataPath, 'data'))) return true;
  return MIGRATED_STATE_ENTRIES.some((entry) => existsSync(join(userDataPath, entry)));
}

/** Guarded move: source exists && dest missing → rename (returns true).
 *  Source exists && dest exists → skip, leave source in place. Source missing →
 *  skip. Idempotent and crash-resumable — safe to re-run after a partial move. */
function moveGuardedSync(source: string, dest: string): boolean {
  if (!existsSync(source)) return false;
  if (existsSync(dest)) return false;
  mkdirSync(dirname(dest), { recursive: true });
  renameSync(source, dest);
  return true;
}

function readThemePaletteSync(uiPreferencesPath: string): { theme?: 'dark' | 'light'; palette?: 'standard' | 'colorblind' } {
  let raw: string;
  try {
    raw = readFileSync(uiPreferencesPath, 'utf-8');
  } catch {
    return {};
  }
  const parsed = parseJsonObject(raw);
  if (parsed === null) return {};
  const out: { theme?: 'dark' | 'light'; palette?: 'standard' | 'colorblind' } = {};
  const theme = parsed['theme'];
  if (theme === 'dark' || theme === 'light') out.theme = theme;
  const palette = parsed['palette'];
  if (palette === 'standard' || palette === 'colorblind') out.palette = palette;
  return out;
}

/** Moves the legacy single-workspace layout into `workspaces/default/`. Each
 *  move is individually guarded, so a crash mid-migration resumes cleanly on
 *  the next run. The caller writes app-state.json LAST — its absence is what
 *  makes a re-run re-enter migration. Legacy `{userData}/temp` stays in place.
 *  Returns the migrated ui-preferences theme/palette so the caller can seed
 *  the machine-level app-state. */
export function migrateLegacyLayoutSync(userDataPath: string): {
  migrated: boolean;
  theme?: 'dark' | 'light';
  palette?: 'standard' | 'colorblind';
} {
  const workspaceRoot = join(userDataPath, 'workspaces', DEFAULT_WORKSPACE_NAME);
  const stateDir = join(workspaceRoot, 'state');
  mkdirSync(stateDir, { recursive: true });

  let migrated = false;
  if (moveGuardedSync(join(userDataPath, 'data'), join(workspaceRoot, 'data'))) migrated = true;
  if (moveGuardedSync(join(userDataPath, 'config'), join(workspaceRoot, 'config'))) migrated = true;
  for (const entry of MIGRATED_STATE_ENTRIES) {
    if (moveGuardedSync(join(userDataPath, entry), join(stateDir, entry))) migrated = true;
  }

  // Theme + palette become machine-level in workspace mode — lift them from the
  // (possibly previously) migrated ui-preferences file, tolerantly.
  const result: { migrated: boolean; theme?: 'dark' | 'light'; palette?: 'standard' | 'colorblind' } = { migrated };
  const prefs = readThemePaletteSync(join(stateDir, 'ui-preferences.json'));
  if (prefs.theme !== undefined) result.theme = prefs.theme;
  if (prefs.palette !== undefined) result.palette = prefs.palette;
  return result;
}

function listWorkspaceNamesSync(workspacesRoot: string): WorkspaceName[] {
  let entries;
  try {
    entries = readdirSync(workspacesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidWorkspaceName(entry.name))
    .map((entry) => parseWorkspaceName(entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Resolves the four working paths for this launch. Pinned mode (either env
 *  override set) reproduces today's behavior byte-for-byte and touches nothing
 *  on disk; workspace mode picks/migrates/creates a workspace and writes
 *  app-state.json last. `env` is a parameter (never `process.env` directly)
 *  for testability. */
export function resolveWorkspaceEnv(userDataPath: string, env: NodeJS.ProcessEnv): WorkspaceEnv {
  const dataDirOverride = env['COSTGOBLIN_DATA_DIR'];
  const configDirOverride = env['COSTGOBLIN_CONFIG_DIR'];

  if (isNonEmptyString(dataDirOverride) || isNonEmptyString(configDirOverride)) {
    const dataDir = isNonEmptyString(dataDirOverride) ? dataDirOverride : join(userDataPath, 'data');
    const configBase = isNonEmptyString(configDirOverride) ? configDirOverride : join(userDataPath, 'config');
    return {
      mode: 'pinned',
      dataDir,
      configBase,
      stateDir: dirname(dataDir),
      tempDir: join(userDataPath, 'temp'),
    };
  }

  const workspacesRoot = join(userDataPath, 'workspaces');
  const appStatePath = join(userDataPath, 'app-state.json');
  const appState = readAppStateSync(appStatePath);

  let name: WorkspaceName | null = null;
  const last = appState.lastWorkspace;
  if (last !== undefined && isValidWorkspaceName(last) && isDirectorySync(join(workspacesRoot, last))) {
    name = parseWorkspaceName(last);
  }

  let migration: { theme?: 'dark' | 'light'; palette?: 'standard' | 'colorblind' } = {};
  if (name === null) {
    const existing = listWorkspaceNamesSync(workspacesRoot);
    if (existing.length > 0) {
      // Most recently used wins; ISO timestamps compare lexicographically.
      // `existing` is sorted alphabetically and the comparison is strict, so
      // ties (including entirely absent timestamps) break alphabetically.
      const lastUsed = appState.lastUsed ?? {};
      let bestTime = '';
      for (const candidate of existing) {
        const time = lastUsed[candidate] ?? '';
        if (name === null || time > bestTime) {
          name = candidate;
          bestTime = time;
        }
      }
    } else if (hasLegacyLayoutSync(userDataPath)) {
      migration = migrateLegacyLayoutSync(userDataPath);
      name = DEFAULT_WORKSPACE_NAME;
    } else {
      name = DEFAULT_WORKSPACE_NAME; // fresh install
    }
  }
  if (name === null) {
    // Unreachable (every branch above assigns), but keeps the narrow explicit.
    name = DEFAULT_WORKSPACE_NAME;
  }

  const paths = workspacePaths(workspacesRoot, name);
  for (const dir of [paths.configBase, paths.dataDir, paths.stateDir, paths.tempDir]) {
    mkdirSync(dir, { recursive: true });
  }

  // app-state.json is written LAST so a crash anywhere above re-enters the
  // same resolution (including migration) on the next launch.
  const nextState: AppStateFile = {
    schemaVersion: APP_STATE_SCHEMA_VERSION,
    lastWorkspace: name,
    lastUsed: { ...appState.lastUsed, [name]: new Date().toISOString() },
  };
  const theme = appState.theme ?? migration.theme;
  if (theme !== undefined) nextState.theme = theme;
  const palette = appState.palette ?? migration.palette;
  if (palette !== undefined) nextState.palette = palette;
  writeAppStateSync(appStatePath, nextState);

  return { mode: 'workspace', name, workspacesRoot, appStatePath, ...paths };
}

/** Directory names under `workspacesRoot` that are valid workspace names —
 *  stray files, `.DS_Store`, and invalid names are ignored. Sorted A→Z. */
export async function listWorkspaceNames(workspacesRoot: string): Promise<WorkspaceName[]> {
  let entries;
  try {
    entries = await readdir(workspacesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && isValidWorkspaceName(entry.name))
    .map((entry) => parseWorkspaceName(entry.name))
    .sort((a, b) => a.localeCompare(b));
}

/** Creates the `config/ data/ state/ temp/` skeleton for a new workspace and
 *  returns its root path. Throws if any entry with the same name already
 *  exists case-insensitively (the workspaces root may live on a
 *  case-insensitive filesystem). */
export async function createWorkspaceDirs(workspacesRoot: string, name: WorkspaceName): Promise<string> {
  await mkdir(workspacesRoot, { recursive: true });
  const entries = await readdir(workspacesRoot);
  const lower = name.toLowerCase();
  const clash = entries.find((entry) => entry.toLowerCase() === lower);
  if (clash !== undefined) {
    throw new Error(`A workspace named "${clash}" already exists.`);
  }
  const root = join(workspacesRoot, name);
  for (const sub of WORKSPACE_SUBDIRS) {
    await mkdir(join(root, sub), { recursive: true });
  }
  return root;
}

/** Renames a workspace directory. Rejects when `to` collides case-insensitively
 *  with another existing entry (renaming a workspace to a different casing of
 *  its own name is allowed). */
export async function renameWorkspaceDir(workspacesRoot: string, from: WorkspaceName, to: WorkspaceName): Promise<void> {
  const entries = await readdir(workspacesRoot);
  const toLower = to.toLowerCase();
  const clash = entries.find((entry) => entry !== from && entry.toLowerCase() === toLower);
  if (clash !== undefined) {
    throw new Error(`A workspace named "${clash}" already exists.`);
  }
  await rename(join(workspacesRoot, from), join(workspacesRoot, to));
}

/** Recursively deletes a workspace directory. Missing directory is a no-op. */
export async function deleteWorkspaceDir(workspacesRoot: string, name: WorkspaceName): Promise<void> {
  await rm(join(workspacesRoot, name), { recursive: true, force: true });
}

/** Total bytes of all files under a workspace directory. Tolerant of races:
 *  entries deleted mid-walk are skipped; a missing root yields 0. */
export async function workspaceSizeBytes(workspacePath: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // directory vanished mid-walk (or never existed)
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        try {
          const info = await stat(entryPath);
          total += info.size;
        } catch {
          // file vanished mid-walk — skip
        }
      }
      // Symlinks and other special entries are intentionally not followed.
    }
  };
  await walk(workspacePath);
  return total;
}
