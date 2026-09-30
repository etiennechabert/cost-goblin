import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { loadViews, SEED_VIEWS_CONFIG, validateViews, viewsConfigToYaml } from '@costgoblin/core';
import type { ViewsConfig } from '@costgoblin/core';
import { loadViewsOrSeed, saveViews, type ViewsFile } from '../main/views-file.js';

// Pass-through fs so a case can inject a failure into one read.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const readFileMock = vi.mocked(readFile);

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// A user's own dashboard — nothing can rebuild it if views.yaml is overwritten.
const USER_VIEWS: ViewsConfig = validateViews({
  views: [{ id: 'team-costs', name: 'Team costs', rows: [{ widgets: [{ id: 'team-summary', type: 'summary', size: 'small', metric: 'total' }] }] }],
});
const USER_TEXT = stringify(viewsConfigToYaml(USER_VIEWS));

const tmpDirs: string[] = [];
let dir: string;
let viewsPath: string;
let invalidations: number;

function viewsFile(): ViewsFile {
  return { path: viewsPath, load: () => loadViews(viewsPath), invalidate: () => { invalidations += 1; } };
}

beforeEach(async () => {
  // Canonical (macOS tmpdir is a symlink): writes resolve their target path.
  dir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-views-file-')));
  tmpDirs.push(dir);
  viewsPath = join(dir, 'views.yaml');
  invalidations = 0;
});

afterEach(() => {
  readFileMock.mockReset();
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe('loadViewsOrSeed', () => {
  it('returns the saved views untouched', async () => {
    await writeFile(viewsPath, USER_TEXT);
    expect(await loadViewsOrSeed(viewsFile())).toEqual(USER_VIEWS);
    expect(await fsActual.readFile(viewsPath, 'utf-8')).toBe(USER_TEXT);
    expect(invalidations).toBe(0);
  });

  it('seeds the default dashboards when views.yaml does not exist', async () => {
    expect(await loadViewsOrSeed(viewsFile())).toEqual(SEED_VIEWS_CONFIG);
    expect(validateViews(parse(await fsActual.readFile(viewsPath, 'utf-8')))).toEqual(SEED_VIEWS_CONFIG);
    expect(invalidations).toBe(1);
    expect(await readdir(dir)).toEqual(['views.yaml']);
  });

  it('rejects, leaving the file alone, on a read failure other than a missing file', async () => {
    await writeFile(viewsPath, USER_TEXT);
    readFileMock.mockImplementation((file, options) =>
      file === viewsPath ? Promise.reject(errnoError('EBUSY')) : fsActual.readFile(file, options));

    await expect(loadViewsOrSeed(viewsFile())).rejects.toThrow('EBUSY');
    expect(await fsActual.readFile(viewsPath, 'utf-8')).toBe(USER_TEXT);
  });

  it('rejects, leaving the file alone, on a hand-edit typo that breaks the YAML', async () => {
    const typo = `${USER_TEXT}\n  - id: [unclosed\n`;
    await writeFile(viewsPath, typo);

    await expect(loadViewsOrSeed(viewsFile())).rejects.toThrow();
    expect(await fsActual.readFile(viewsPath, 'utf-8')).toBe(typo);
  });

  it('rejects, leaving the file alone, when the YAML parses but does not validate', async () => {
    const invalid = 'views:\n  - name: no id\n';
    await writeFile(viewsPath, invalid);

    await expect(loadViewsOrSeed(viewsFile())).rejects.toThrow();
    expect(await fsActual.readFile(viewsPath, 'utf-8')).toBe(invalid);
  });

  it('rejects, leaving the file alone, on a torn (truncated) write', async () => {
    const torn = USER_TEXT.slice(0, Math.floor(USER_TEXT.length / 2));
    await writeFile(viewsPath, torn);

    await expect(loadViewsOrSeed(viewsFile())).rejects.toThrow();
    expect(await fsActual.readFile(viewsPath, 'utf-8')).toBe(torn);
  });
});

describe('saveViews', () => {
  it('replaces views.yaml whole, leaving no temp file, and drops the load cache', async () => {
    await writeFile(viewsPath, stringify(viewsConfigToYaml(SEED_VIEWS_CONFIG)));
    await saveViews(viewsFile(), USER_VIEWS);
    expect(await fsActual.readFile(viewsPath, 'utf-8')).toBe(USER_TEXT);
    expect(await readdir(dir)).toEqual(['views.yaml']);
    expect(invalidations).toBe(1);
  });
});
