import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseJsonObject } from '@costgoblin/core';
import { updatePrefsFile } from '../main/handlers/prefs-file.js';

// Pass-through fs so a case can inject a failure into one read; the helper
// reads through @costgoblin/core's atomic-file module, which imports this one.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
const readFileMock = vi.mocked(readFile);

function errnoError(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

// Slices written by the file's other writers — telemetry opt-in, update
// check, MCP state — that a theme save must never drop.
const OTHER_SLICES = { telemetry: { errorReports: true }, updates: { checkOnStartup: false }, mcp: { enabled: true } };
const PERSISTED_TEXT = JSON.stringify({ theme: 'light', ...OTHER_SLICES }, null, 2);

const tmpDirs: string[] = [];
let dir: string;
let prefsFile: string;

beforeEach(async () => {
  // Canonical (macOS tmpdir is a symlink): writes resolve their target path.
  dir = await fsActual.realpath(await mkdtemp(join(tmpdir(), 'cg-prefs-file-')));
  tmpDirs.push(dir);
  prefsFile = join(dir, 'ui-preferences.json');
});

afterEach(() => {
  readFileMock.mockReset();
});

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

const setTheme = (theme: string) => (current: Readonly<Record<string, unknown>>) => ({ ...current, theme });

async function readPrefs(): Promise<Readonly<Record<string, unknown>> | null> {
  return parseJsonObject(await fsActual.readFile(prefsFile, 'utf-8'));
}

describe('updatePrefsFile', () => {
  it('creates a missing file with just the new slice', async () => {
    await updatePrefsFile(prefsFile, setTheme('dark'));
    expect(await readPrefs()).toEqual({ theme: 'dark' });
  });

  it('merges into the existing slices, leaving no temp file behind', async () => {
    await writeFile(prefsFile, PERSISTED_TEXT);
    await updatePrefsFile(prefsFile, setTheme('dark'));
    expect(await readPrefs()).toEqual({ theme: 'dark', ...OTHER_SLICES });
    expect(await readdir(dir)).toEqual(['ui-preferences.json']);
  });

  it('rejects on a read failure other than a missing file, leaving every slice in place', async () => {
    await writeFile(prefsFile, PERSISTED_TEXT);
    readFileMock.mockImplementation((file, options) =>
      file === prefsFile ? Promise.reject(errnoError('EIO')) : fsActual.readFile(file, options));

    await expect(updatePrefsFile(prefsFile, setTheme('dark'))).rejects.toThrow('EIO');
    expect(await fsActual.readFile(prefsFile, 'utf-8')).toBe(PERSISTED_TEXT);
  });

  it('retries a transient lock or descriptor error instead of starting from empty', async () => {
    await writeFile(prefsFile, PERSISTED_TEXT);
    let failures = 0;
    readFileMock.mockImplementation((file, options) => {
      if (file === prefsFile && failures < 2) {
        failures += 1;
        return Promise.reject(errnoError(failures === 1 ? 'EBUSY' : 'EMFILE'));
      }
      return fsActual.readFile(file, options);
    });

    await updatePrefsFile(prefsFile, setTheme('dark'));

    expect(failures).toBe(2);
    expect(await readPrefs()).toEqual({ theme: 'dark', ...OTHER_SLICES });
  });

  it('moves an unparseable file aside, bytes kept, before starting afresh', async () => {
    const torn = '{"theme":"light","telemetry":{"errorRep';
    await writeFile(prefsFile, torn);

    await updatePrefsFile(prefsFile, setTheme('dark'));

    expect(await readPrefs()).toEqual({ theme: 'dark' });
    const aside = (await readdir(dir)).filter((n) => n.startsWith('ui-preferences.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(await fsActual.readFile(join(dir, aside[0] ?? ''), 'utf-8')).toBe(torn);
  });

  it('reads a hand-edited file saved with a UTF-8 BOM', async () => {
    await writeFile(prefsFile, `\uFEFF${PERSISTED_TEXT}`);
    await updatePrefsFile(prefsFile, setTheme('dark'));
    expect(await readPrefs()).toEqual({ theme: 'dark', ...OTHER_SLICES });
  });

  it('keeps later updates going after one fails', async () => {
    await writeFile(prefsFile, PERSISTED_TEXT);
    readFileMock.mockImplementationOnce(() => Promise.reject(errnoError('EIO')));
    await expect(updatePrefsFile(prefsFile, setTheme('dark'))).rejects.toThrow('EIO');

    await updatePrefsFile(prefsFile, setTheme('dark'));
    expect(await readPrefs()).toEqual({ theme: 'dark', ...OTHER_SLICES });
  });
});
