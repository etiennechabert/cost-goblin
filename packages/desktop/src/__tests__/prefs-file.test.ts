import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@costgoblin/core';
import { updatePrefsFile } from '../main/handlers/prefs-file.js';

// Every test runs against a real temp dir. The fs calls an update goes through
// are pass-through wrappers, so a test can fail one read, write or rename, or
// look at the directory at the moment of the rename. Seeding and inspecting go
// through the sync API, which the mock leaves alone.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
    writeFile: vi.fn(actual.writeFile),
  };
});
// The retry delays resolve at once; tests assert the delays that were asked for.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(() => Promise.resolve()) }));

const fsActual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');

const FILE_NAME = 'ui-preferences.json';
const OLD = { theme: 'dark', telemetry: { errorReports: true } };
const OLD_TEXT = JSON.stringify(OLD, null, 2);
const RETRY_DELAYS_MS = [25, 50, 100];

let dir: string;
let prefsFile: string;

const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: injected`), { code });
const onDisk = (): unknown => JSON.parse(readFileSync(prefsFile, 'utf-8'));
const sleptMs = (): unknown[] => vi.mocked(sleep).mock.calls.map(([ms]) => ms);
/** Every path `writeFile` was asked to write, in order. */
const writtenPaths = (): unknown[] => vi.mocked(writeFile).mock.calls.map(([path]) => path);
const setLight = (current: Readonly<Record<string, unknown>>): Record<string, unknown> => ({ ...current, theme: 'light' });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cg-prefs-file-'));
  prefsFile = join(dir, FILE_NAME);
});

afterEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(rename).mockReset();
  vi.mocked(rm).mockReset();
  vi.mocked(writeFile).mockReset();
  vi.mocked(sleep).mockReset();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('updatePrefsFile — atomic replace', () => {
  it('keeps the complete old file in place until a finished temp file is renamed over it', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    const atRename: unknown[] = [];
    vi.mocked(rename).mockImplementationOnce(async (from, to) => {
      const temp: unknown = JSON.parse(readFileSync(String(from), 'utf-8'));
      atRename.push({ to, tempDir: dirname(String(from)), target: readFileSync(prefsFile, 'utf-8'), temp });
      await fsActual.rename(from, to);
    });

    await updatePrefsFile(prefsFile, setLight);

    // A reader at any moment finds either file whole: the old one right up to
    // the rename, the new one after it. The temp file is in the same directory,
    // so the rename never crosses a filesystem.
    expect(atRename).toStrictEqual([{ to: prefsFile, tempDir: dir, target: OLD_TEXT, temp: { ...OLD, theme: 'light' } }]);
    expect(onDisk()).toStrictEqual({ ...OLD, theme: 'light' });
    // Nothing ever wrote to the target itself, and the renamed temp file
    // needs no removal.
    expect(writtenPaths()).not.toContain(prefsFile);
    expect(rm).not.toHaveBeenCalled();
  });

  it('leaves no temp file behind, whether it replaces the file or creates it', async () => {
    await updatePrefsFile(prefsFile, setLight);
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
    expect(onDisk()).toStrictEqual({ theme: 'light' });

    await updatePrefsFile(prefsFile, (current) => ({ ...current, autoSync: true }));
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
    expect(onDisk()).toStrictEqual({ theme: 'light', autoSync: true });
  });

  it('keeps the old file and removes the temp file when the write fails, then takes the next update', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    // A disk that fills up part-way: some bytes land, then the write fails.
    vi.mocked(writeFile).mockImplementationOnce(async (path, data) => {
      await fsActual.writeFile(path, typeof data === 'string' ? data.slice(0, 12) : '');
      throw errno('ENOSPC');
    });

    await expect(updatePrefsFile(prefsFile, setLight)).rejects.toMatchObject({ code: 'ENOSPC' });

    expect(readFileSync(prefsFile, 'utf-8')).toBe(OLD_TEXT);
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
    expect(rename).not.toHaveBeenCalled();

    await updatePrefsFile(prefsFile, (current) => ({ ...current, autoSync: true }));
    expect(onDisk()).toStrictEqual({ ...OLD, autoSync: true });
  });

  it('rejects, without retrying or writing in place, when the rename fails for any other reason', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    vi.mocked(rename).mockRejectedValueOnce(errno('EIO'));

    await expect(updatePrefsFile(prefsFile, setLight)).rejects.toMatchObject({ code: 'EIO' });

    expect(readFileSync(prefsFile, 'utf-8')).toBe(OLD_TEXT);
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(sleptMs()).toStrictEqual([]);
    expect(writtenPaths()).not.toContain(prefsFile);

    await updatePrefsFile(prefsFile, setLight);
    expect(onDisk()).toStrictEqual({ ...OLD, theme: 'light' });
  });
});

// Windows refuses to rename over a file while antivirus, the indexer or a
// reader in this app has the target or the temp file open. No Windows machine
// runs these tests, so the refusals are injected.
describe('updatePrefsFile — a rename the system refuses', () => {
  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a rename refused with %s until it goes through', async (code) => {
    writeFileSync(prefsFile, OLD_TEXT);
    vi.mocked(rename).mockRejectedValueOnce(errno(code)).mockRejectedValueOnce(errno(code));

    await updatePrefsFile(prefsFile, setLight);

    expect(rename).toHaveBeenCalledTimes(3);
    expect(sleptMs()).toStrictEqual(RETRY_DELAYS_MS.slice(0, 2));
    expect(writtenPaths()).not.toContain(prefsFile);
    expect(onDisk()).toStrictEqual({ ...OLD, theme: 'light' });
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
  });

  it('writes the file in place, as before, when the rename is still refused after the retries', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    vi.mocked(rename).mockRejectedValue(errno('EPERM'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await updatePrefsFile(prefsFile, setLight);

    expect(rename).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1);
    expect(sleptMs()).toStrictEqual(RETRY_DELAYS_MS);
    expect(writtenPaths().at(-1)).toBe(prefsFile);
    expect(onDisk()).toStrictEqual({ ...OLD, theme: 'light' });
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
    // The one sign that a save was not atomic; it names the file, not its path.
    expect(warn.mock.calls).toStrictEqual([[expect.stringMatching(/ui-preferences\.json.*EPERM/)]]);
    expect(warn.mock.calls[0]?.[0]).not.toContain(dir);
  });

  it('rejects with the in-place failure and removes the temp file when the fallback fails too', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    vi.mocked(rename).mockRejectedValue(errno('EBUSY'));
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // The temp file is written for real; the in-place write is refused before it truncates.
    vi.mocked(writeFile).mockImplementationOnce(fsActual.writeFile).mockRejectedValueOnce(errno('EACCES'));

    await expect(updatePrefsFile(prefsFile, setLight)).rejects.toMatchObject({ code: 'EACCES' });

    expect(readFileSync(prefsFile, 'utf-8')).toBe(OLD_TEXT);
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);

    vi.mocked(rename).mockReset();
    await updatePrefsFile(prefsFile, setLight);
    expect(onDisk()).toStrictEqual({ ...OLD, theme: 'light' });
  });
});

describe('updatePrefsFile — what the update starts from', () => {
  it('rejects and leaves alone a file that is there but cannot be read', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    vi.mocked(readFile).mockRejectedValue(errno('EACCES'));
    const mutate = vi.fn(setLight);

    await expect(updatePrefsFile(prefsFile, mutate)).rejects.toMatchObject({ code: 'EACCES' });

    // Read as "no file yet", this save would have replaced every other slice
    // with its own: a rename needs no access to the file it replaces.
    expect(sleptMs()).toStrictEqual(RETRY_DELAYS_MS);
    expect(mutate).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(readFileSync(prefsFile, 'utf-8')).toBe(OLD_TEXT);
    expect(readdirSync(dir)).toStrictEqual([FILE_NAME]);
  });

  it('waits out a read the system refuses for a moment, and keeps the other slices', async () => {
    writeFileSync(prefsFile, OLD_TEXT);
    vi.mocked(readFile).mockRejectedValueOnce(errno('EBUSY'));

    await updatePrefsFile(prefsFile, setLight);

    expect(sleptMs()).toStrictEqual(RETRY_DELAYS_MS.slice(0, 1));
    expect(onDisk()).toStrictEqual({ ...OLD, theme: 'light' });
  });

  it.each([
    ['is empty', ''],
    ['is cut short', OLD_TEXT.slice(0, 20)],
    ['holds an array', '[1, 2]'],
  ])('starts over from {} and says so when the file %s', async (_label, contents) => {
    writeFileSync(prefsFile, contents);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    await updatePrefsFile(prefsFile, setLight);

    expect(onDisk()).toStrictEqual({ theme: 'light' });
    expect(warn.mock.calls).toStrictEqual([[expect.stringContaining(FILE_NAME)]]);
    expect(warn.mock.calls[0]?.[0]).not.toContain(dir);
  });
});
