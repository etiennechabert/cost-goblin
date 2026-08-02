import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseWorkspaceName } from '@costgoblin/core';
import {
  MIGRATED_STATE_ENTRIES,
  createWorkspaceDirs,
  deleteWorkspaceDir,
  listWorkspaceNames,
  migrateLegacyLayoutSync,
  readAppStateSync,
  renameWorkspaceDir,
  resolveWorkspaceEnv,
  workspacePaths,
  workspaceSizeBytes,
  writeAppStateSync,
} from '../main/workspace-env.js';
import type { WorkspaceEnv } from '../main/workspace-env.js';

let userData = '';

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), 'cg-workspace-env-'));
});

afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const ws = parseWorkspaceName;

function expectWorkspaceMode(env: WorkspaceEnv): Extract<WorkspaceEnv, { mode: 'workspace' }> {
  if (env.mode !== 'workspace') throw new Error('expected workspace mode, got pinned');
  return env;
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf-8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`expected a JSON object at ${path}`);
  }
  return { ...parsed };
}

async function seedLegacyLayout(): Promise<void> {
  await mkdir(join(userData, 'config'), { recursive: true });
  await writeFile(join(userData, 'config', 'costgoblin.yaml'), 'providers: []\n');
  await mkdir(join(userData, 'data', 'aws', 'raw', '2026-01'), { recursive: true });
  await writeFile(join(userData, 'data', 'aws', 'raw', '2026-01', 'part.parquet'), 'parquet-bytes');
  await writeFile(join(userData, 'ui-preferences.json'), JSON.stringify({ theme: 'light', palette: 'colorblind', defaultViewId: 'overview' }));
  await writeFile(join(userData, 'org-accounts.json'), '{"accounts":[]}');
  await writeFile(join(userData, 'telemetry-outbox.jsonl'), '{"eventId":"e1"}\n');
  await mkdir(join(userData, 'raw'), { recursive: true });
  await writeFile(join(userData, 'raw', 'accounts.csv'), 'id,name\n');
}

describe('resolveWorkspaceEnv — pinned mode', () => {
  it('COSTGOBLIN_DATA_DIR alone pins data dir and derives stateDir from it', () => {
    const pinnedData = join(userData, 'elsewhere', 'data');
    const env = resolveWorkspaceEnv(userData, { COSTGOBLIN_DATA_DIR: pinnedData });
    expect(env.mode).toBe('pinned');
    expect(env.dataDir).toBe(pinnedData);
    expect(env.configBase).toBe(join(userData, 'config'));
    expect(env.stateDir).toBe(join(userData, 'elsewhere'));
    expect(env.tempDir).toBe(join(userData, 'temp'));
  });

  it('COSTGOBLIN_CONFIG_DIR alone pins config and leaves data at the userData default', () => {
    const pinnedConfig = join(userData, 'shared-config');
    const env = resolveWorkspaceEnv(userData, { COSTGOBLIN_CONFIG_DIR: pinnedConfig });
    expect(env.mode).toBe('pinned');
    expect(env.dataDir).toBe(join(userData, 'data'));
    expect(env.configBase).toBe(pinnedConfig);
    expect(env.stateDir).toBe(userData);
    expect(env.tempDir).toBe(join(userData, 'temp'));
  });

  it('both env vars pin both paths', () => {
    const env = resolveWorkspaceEnv(userData, {
      COSTGOBLIN_DATA_DIR: '/pin/data',
      COSTGOBLIN_CONFIG_DIR: '/pin/config',
    });
    expect(env.mode).toBe('pinned');
    expect(env.dataDir).toBe('/pin/data');
    expect(env.configBase).toBe('/pin/config');
    expect(env.stateDir).toBe('/pin');
  });

  it('pinned mode writes nothing to disk', () => {
    resolveWorkspaceEnv(userData, { COSTGOBLIN_DATA_DIR: join(userData, 'd') });
    expect(existsSync(join(userData, 'app-state.json'))).toBe(false);
    expect(existsSync(join(userData, 'workspaces'))).toBe(false);
    expect(existsSync(join(userData, 'temp'))).toBe(false);
  });

  it('empty-string env overrides do not pin', () => {
    const env = resolveWorkspaceEnv(userData, { COSTGOBLIN_DATA_DIR: '', COSTGOBLIN_CONFIG_DIR: '' });
    expect(env.mode).toBe('workspace');
  });
});

describe('resolveWorkspaceEnv — fresh install', () => {
  it('creates the default workspace skeleton and app-state.json', () => {
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('default');
    expect(env.workspacesRoot).toBe(join(userData, 'workspaces'));
    expect(env.appStatePath).toBe(join(userData, 'app-state.json'));

    const root = join(userData, 'workspaces', 'default');
    expect(env.dataDir).toBe(join(root, 'data'));
    expect(env.configBase).toBe(join(root, 'config'));
    expect(env.stateDir).toBe(join(root, 'state'));
    expect(env.tempDir).toBe(join(root, 'temp'));
    for (const sub of ['config', 'data', 'state', 'temp']) {
      expect(existsSync(join(root, sub)), sub).toBe(true);
    }

    const state = readAppStateSync(env.appStatePath);
    expect(state.schemaVersion).toBe(1);
    expect(state.lastWorkspace).toBe('default');
    const stamp = state.lastUsed?.['default'];
    expect(stamp).toBeDefined();
    expect(Number.isNaN(Date.parse(stamp ?? ''))).toBe(false);
    // No migration ran and no prefs exist — theme/palette must stay unset.
    expect(state.theme).toBeUndefined();
    expect(state.palette).toBeUndefined();
  });
});

describe('resolveWorkspaceEnv — legacy migration', () => {
  it('moves data, config, state files, and raw/ into workspaces/default and lifts theme/palette', async () => {
    await seedLegacyLayout();
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('default');

    const root = join(userData, 'workspaces', 'default');
    expect(await readFile(join(root, 'config', 'costgoblin.yaml'), 'utf-8')).toBe('providers: []\n');
    expect(await readFile(join(root, 'data', 'aws', 'raw', '2026-01', 'part.parquet'), 'utf-8')).toBe('parquet-bytes');
    expect(existsSync(join(root, 'state', 'ui-preferences.json'))).toBe(true);
    expect(existsSync(join(root, 'state', 'org-accounts.json'))).toBe(true);
    expect(existsSync(join(root, 'state', 'telemetry-outbox.jsonl'))).toBe(true);
    expect(await readFile(join(root, 'state', 'raw', 'accounts.csv'), 'utf-8')).toBe('id,name\n');

    // Originals are gone from the userData root.
    expect(existsSync(join(userData, 'data'))).toBe(false);
    expect(existsSync(join(userData, 'config'))).toBe(false);
    expect(existsSync(join(userData, 'ui-preferences.json'))).toBe(false);
    expect(existsSync(join(userData, 'raw'))).toBe(false);

    // Theme + palette became machine-level.
    const state = readAppStateSync(env.appStatePath);
    expect(state.theme).toBe('light');
    expect(state.palette).toBe('colorblind');
    expect(state.lastWorkspace).toBe('default');
  });

  it('is triggered by a lone legacy state file (no data/ or config yaml)', async () => {
    await writeFile(join(userData, 'dismissed-suggestions.json'), '{"ids":[]}');
    expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(existsSync(join(userData, 'workspaces', 'default', 'state', 'dismissed-suggestions.json'))).toBe(true);
    expect(existsSync(join(userData, 'dismissed-suggestions.json'))).toBe(false);
  });

  it('does not let migrated prefs override theme/palette already present in app-state', async () => {
    await seedLegacyLayout();
    writeAppStateSync(join(userData, 'app-state.json'), { schemaVersion: 1, theme: 'dark', palette: 'standard' });
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    const state = readAppStateSync(env.appStatePath);
    expect(state.theme).toBe('dark');
    expect(state.palette).toBe('standard');
  });
});

describe('migrateLegacyLayoutSync — idempotent, crash-resumable', () => {
  it('resumes after a partial move without touching already-moved files', async () => {
    await seedLegacyLayout();
    // Simulate a crash mid-migration: org-accounts.json already landed in the
    // workspace, and a stale copy ALSO reappeared at the root (dest wins).
    const stateDir = join(userData, 'workspaces', 'default', 'state');
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'org-accounts.json'), '{"accounts":["already-moved"]}');

    const first = migrateLegacyLayoutSync(userData);
    expect(first.migrated).toBe(true);
    expect(first.theme).toBe('light');
    expect(first.palette).toBe('colorblind');

    // The pre-moved dest was not overwritten, and its stale source stayed put.
    expect(await readFile(join(stateDir, 'org-accounts.json'), 'utf-8')).toBe('{"accounts":["already-moved"]}');
    expect(await readFile(join(userData, 'org-accounts.json'), 'utf-8')).toBe('{"accounts":[]}');
    // Everything else still moved.
    expect(existsSync(join(userData, 'workspaces', 'default', 'data'))).toBe(true);
    expect(existsSync(join(userData, 'workspaces', 'default', 'config', 'costgoblin.yaml'))).toBe(true);
    expect(existsSync(join(stateDir, 'ui-preferences.json'))).toBe(true);
    expect(existsSync(join(userData, 'data'))).toBe(false);

    // Second run: nothing left to move, still no throw, prefs still reported.
    const second = migrateLegacyLayoutSync(userData);
    expect(second.migrated).toBe(false);
    expect(second.theme).toBe('light');
  });

  it('is a no-op on an empty userData directory', () => {
    const result = migrateLegacyLayoutSync(userData);
    expect(result.migrated).toBe(false);
    expect(result.theme).toBeUndefined();
    expect(result.palette).toBeUndefined();
  });

  it('covers every legacy state entry in MIGRATED_STATE_ENTRIES', async () => {
    for (const entry of MIGRATED_STATE_ENTRIES) {
      if (entry === 'raw') continue;
      await writeFile(join(userData, entry), `content-of-${entry}`);
    }
    migrateLegacyLayoutSync(userData);
    const stateDir = join(userData, 'workspaces', 'default', 'state');
    for (const entry of MIGRATED_STATE_ENTRIES) {
      if (entry === 'raw') continue;
      expect(await readFile(join(stateDir, entry), 'utf-8'), entry).toBe(`content-of-${entry}`);
      expect(existsSync(join(userData, entry)), entry).toBe(false);
    }
  });
});

describe('resolveWorkspaceEnv — workspace pick order', () => {
  async function seedWorkspaces(): Promise<void> {
    await mkdir(join(userData, 'workspaces', 'alpha'), { recursive: true });
    await mkdir(join(userData, 'workspaces', 'beta'), { recursive: true });
  }

  it('uses a valid lastWorkspace whose directory exists', async () => {
    await seedWorkspaces();
    writeAppStateSync(join(userData, 'app-state.json'), {
      lastWorkspace: 'alpha',
      lastUsed: { alpha: '2026-01-01T00:00:00.000Z', beta: '2026-06-01T00:00:00.000Z' },
    });
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    // lastWorkspace wins even though beta was used more recently.
    expect(env.name).toBe('alpha');
  });

  it('falls back to the most recently used workspace when lastWorkspace points nowhere', async () => {
    await seedWorkspaces();
    writeAppStateSync(join(userData, 'app-state.json'), {
      lastWorkspace: 'ghost',
      lastUsed: { alpha: '2026-01-01T00:00:00.000Z', beta: '2026-06-01T00:00:00.000Z' },
    });
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('beta');
    // app-state was repaired: lastWorkspace now points at the pick, history kept.
    const state = readAppStateSync(env.appStatePath);
    expect(state.lastWorkspace).toBe('beta');
    expect(state.lastUsed?.['alpha']).toBe('2026-01-01T00:00:00.000Z');
    expect(state.lastUsed?.['beta'] ?? '').not.toBe('2026-06-01T00:00:00.000Z');
  });

  it('falls back when lastWorkspace is not a valid name (path traversal)', async () => {
    await seedWorkspaces();
    writeAppStateSync(join(userData, 'app-state.json'), {
      lastWorkspace: '../evil',
      lastUsed: { beta: '2026-06-01T00:00:00.000Z' },
    });
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('beta');
  });

  it('breaks lastUsed ties alphabetically', async () => {
    await seedWorkspaces();
    writeAppStateSync(join(userData, 'app-state.json'), {
      lastUsed: { alpha: '2026-01-01T00:00:00.000Z', beta: '2026-01-01T00:00:00.000Z' },
    });
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('alpha');
  });

  it('picks alphabetically when no lastUsed data exists at all', async () => {
    await seedWorkspaces();
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('alpha');
  });

  it('creates default when app-state points nowhere and no workspaces or legacy layout exist', () => {
    writeAppStateSync(join(userData, 'app-state.json'), { lastWorkspace: 'ghost' });
    const env = expectWorkspaceMode(resolveWorkspaceEnv(userData, {}));
    expect(env.name).toBe('default');
    expect(existsSync(join(userData, 'workspaces', 'default', 'config'))).toBe(true);
  });
});

describe('readAppStateSync', () => {
  it('returns {} for a missing file', () => {
    expect(readAppStateSync(join(userData, 'app-state.json'))).toEqual({});
  });

  it('returns {} for unreadable JSON', async () => {
    const path = join(userData, 'app-state.json');
    await writeFile(path, 'not json {');
    expect(readAppStateSync(path)).toEqual({});
  });

  it('returns {} for a non-object root', async () => {
    const path = join(userData, 'app-state.json');
    await writeFile(path, '[1,2,3]');
    expect(readAppStateSync(path)).toEqual({});
  });

  it('salvages only correctly-shaped fields', async () => {
    const path = join(userData, 'app-state.json');
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: '1',
        lastWorkspace: 42,
        lastUsed: { good: '2026-01-01T00:00:00.000Z', bad: 7 },
        theme: 'blue',
        palette: 'colorblind',
      }),
    );
    expect(readAppStateSync(path)).toEqual({
      lastUsed: { good: '2026-01-01T00:00:00.000Z' },
      palette: 'colorblind',
    });
  });
});

describe('writeAppStateSync', () => {
  it('writes a readable file and leaves no temp files behind', async () => {
    const path = join(userData, 'app-state.json');
    writeAppStateSync(path, { schemaVersion: 1, lastWorkspace: 'default', theme: 'dark' });
    expect(readAppStateSync(path)).toEqual({ schemaVersion: 1, lastWorkspace: 'default', theme: 'dark' });
    const leftovers = (await readdir(userData)).filter((entry) => entry.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('overwrites an existing file', async () => {
    const path = join(userData, 'app-state.json');
    writeAppStateSync(path, { lastWorkspace: 'one' });
    writeAppStateSync(path, { lastWorkspace: 'two' });
    expect((await readJson(path))['lastWorkspace']).toBe('two');
  });
});

describe('listWorkspaceNames', () => {
  it('returns only directories with valid workspace names, sorted', async () => {
    const root = join(userData, 'workspaces');
    await mkdir(join(root, 'alpha'), { recursive: true });
    await mkdir(join(root, 'Beta-2'), { recursive: true });
    await mkdir(join(root, 'bad name'), { recursive: true }); // invalid: space
    await mkdir(join(root, 'con'), { recursive: true }); // invalid: reserved
    await writeFile(join(root, '.DS_Store'), '');
    await writeFile(join(root, 'stray.txt'), 'not a workspace');
    expect(await listWorkspaceNames(root)).toEqual(['alpha', 'Beta-2']);
  });

  it('returns [] for a missing root', async () => {
    expect(await listWorkspaceNames(join(userData, 'nope'))).toEqual([]);
  });
});

describe('createWorkspaceDirs', () => {
  it('creates the skeleton and returns the workspace root', async () => {
    const root = join(userData, 'workspaces');
    const created = await createWorkspaceDirs(root, ws('staging'));
    expect(created).toBe(join(root, 'staging'));
    for (const sub of ['config', 'data', 'state', 'temp']) {
      expect(existsSync(join(created, sub)), sub).toBe(true);
    }
  });

  it('rejects a case-insensitive collision', async () => {
    const root = join(userData, 'workspaces');
    await createWorkspaceDirs(root, ws('Dev'));
    await expect(createWorkspaceDirs(root, ws('dev'))).rejects.toThrow(/already exists/);
    await expect(createWorkspaceDirs(root, ws('DEV'))).rejects.toThrow(/already exists/);
  });
});

describe('renameWorkspaceDir', () => {
  it('renames a workspace directory', async () => {
    const root = join(userData, 'workspaces');
    await createWorkspaceDirs(root, ws('old-name'));
    await renameWorkspaceDir(root, ws('old-name'), ws('new-name'));
    expect(existsSync(join(root, 'old-name'))).toBe(false);
    expect(existsSync(join(root, 'new-name', 'config'))).toBe(true);
  });

  it('rejects renaming onto another workspace case-insensitively', async () => {
    const root = join(userData, 'workspaces');
    await createWorkspaceDirs(root, ws('one'));
    await createWorkspaceDirs(root, ws('two'));
    await expect(renameWorkspaceDir(root, ws('one'), ws('TWO'))).rejects.toThrow(/already exists/);
  });
});

describe('deleteWorkspaceDir', () => {
  it('removes the workspace recursively and tolerates a missing one', async () => {
    const root = join(userData, 'workspaces');
    const created = await createWorkspaceDirs(root, ws('doomed'));
    await writeFile(join(created, 'data', 'file.parquet'), 'bytes');
    await deleteWorkspaceDir(root, ws('doomed'));
    expect(existsSync(created)).toBe(false);
    await expect(deleteWorkspaceDir(root, ws('doomed'))).resolves.toBeUndefined();
  });
});

describe('workspaceSizeBytes', () => {
  it('sums file sizes recursively', async () => {
    const root = join(userData, 'sized');
    await mkdir(join(root, 'sub', 'deep'), { recursive: true });
    await writeFile(join(root, 'a.txt'), 'abc'); // 3
    await writeFile(join(root, 'sub', 'b.txt'), 'abcde'); // 5
    await writeFile(join(root, 'sub', 'deep', 'c.txt'), 'abcdefg'); // 7
    expect(await workspaceSizeBytes(root)).toBe(15);
  });

  it('returns 0 for a missing directory', async () => {
    expect(await workspaceSizeBytes(join(userData, 'missing'))).toBe(0);
  });
});

describe('workspacePaths', () => {
  it('maps a workspace name to its four standard subpaths', () => {
    const paths = workspacePaths('/ud/workspaces', ws('acme'));
    expect(paths).toEqual({
      dataDir: '/ud/workspaces/acme/data',
      configBase: '/ud/workspaces/acme/config',
      stateDir: '/ud/workspaces/acme/state',
      tempDir: '/ud/workspaces/acme/temp',
    });
  });
});
