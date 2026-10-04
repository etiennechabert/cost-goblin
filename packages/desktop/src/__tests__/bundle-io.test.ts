import { access, copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildConfigBundle, loadConfig, loadDimensions, serializeConfigBundle } from '@costgoblin/core';
import { applyBundleSectionsToDisk, backupExistingConfig, type ConfigFilePaths } from '../main/handlers/bundle-io.js';

// bundle-io reads the app version for exports; nothing here exports.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0-test' } }));

// Pass-through fs so a case can inject a failure into one call.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile), access: vi.fn(actual.access) };
});

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const readFileMock = vi.mocked(readFile);
const accessMock = vi.mocked(access);

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_CONFIG_DIR = join(__dirname, '..', '..', '..', 'core', 'src', '__fixtures__', 'config');

let bundleText: string;
beforeAll(async () => {
  const config = await loadConfig(join(FIXTURE_CONFIG_DIR, 'costgoblin.yaml'));
  const dimensions = await loadDimensions(join(FIXTURE_CONFIG_DIR, 'dimensions.yaml'));
  bundleText = serializeConfigBundle(buildConfigBundle({ config, dimensions, appVersion: '0.0.0-test' }));
});

const tmpDirs: string[] = [];
let dir: string;
let paths: ConfigFilePaths;

beforeEach(async () => {
  // Canonical (macOS tmpdir is a symlink): writes resolve their target path.
  dir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-bundle-io-')));
  tmpDirs.push(dir);
  paths = {
    configPath: join(dir, 'costgoblin.yaml'),
    dimensionsPath: join(dir, 'dimensions.yaml'),
    orgTreePath: join(dir, 'org-tree.yaml'),
    viewsPath: join(dir, 'views.yaml'),
    costScopePath: join(dir, 'cost-scope.yaml'),
  };
  for (const name of ['costgoblin.yaml', 'dimensions.yaml']) {
    await copyFile(join(FIXTURE_CONFIG_DIR, name), join(dir, name));
  }
});

afterEach(() => {
  readFileMock.mockReset();
  accessMock.mockReset();
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

async function snapshot(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await readdir(dir)) {
    if (name.endsWith('.yaml')) out[name] = await fsActual.readFile(join(dir, name), 'utf-8');
  }
  return out;
}

describe('applyBundleSectionsToDisk', () => {
  it('writes every section, backing up what it replaces, with no temp file left', async () => {
    const result = await applyBundleSectionsToDisk(paths, bundleText, 'imported-profile');
    expect(result.backupDir).not.toBeNull();
    expect(await fsActual.readFile(paths.configPath, 'utf-8')).toContain('imported-profile');
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects before writing anything when the current config cannot be read', async () => {
    // Its providers' credentials (a GCP keyFile) are carried across by name:
    // reading them as "none" would write the imported config without them.
    const before = await snapshot();
    readFileMock.mockImplementation((file, options) =>
      file === paths.configPath ? Promise.reject(errnoError('EIO')) : fsActual.readFile(file, options));

    await expect(applyBundleSectionsToDisk(paths, bundleText, 'imported-profile')).rejects.toThrow('EIO');
    expect(await snapshot()).toEqual(before);
  });

  it('still imports over a config too broken to parse (it is backed up first)', async () => {
    await writeFile(paths.configPath, 'providers:\n  - name: [unclosed\n');
    const result = await applyBundleSectionsToDisk(paths, bundleText, 'imported-profile');
    expect(result.backupDir).not.toBeNull();
    expect(await fsActual.readFile(join(result.backupDir ?? '', 'costgoblin.yaml'), 'utf-8')).toBe('providers:\n  - name: [unclosed\n');
    expect(await fsActual.readFile(paths.configPath, 'utf-8')).toContain('imported-profile');
  });
});

describe('backupExistingConfig', () => {
  it('rejects, rather than skip it, when a config file cannot be checked', async () => {
    accessMock.mockImplementation((file, mode) =>
      file === paths.dimensionsPath ? Promise.reject(errnoError('EIO')) : fsActual.access(file, mode));
    await expect(backupExistingConfig(paths)).rejects.toThrow('EIO');
  });

  it('skips files that do not exist', async () => {
    const backupDir = await backupExistingConfig(paths);
    expect((await readdir(backupDir ?? '')).sort()).toEqual(['costgoblin.yaml', 'dimensions.yaml']);
  });
});
