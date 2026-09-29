import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseJsonObject } from '@costgoblin/core';
import type { UpdatePreferences } from '@costgoblin/core';
import { updatePrefsFile } from '../main/handlers/prefs-file.js';
import {
  DISABLE_UPDATE_CHECK_ENV,
  persistCheckOnStartup,
  readCheckOnStartup,
  shouldCheckOnStartup,
} from '../main/update-prefs.js';

let dir: string;
let prefsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cg-update-prefs-'));
  prefsFile = join(dir, 'ui-preferences.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function readPrefs(): Promise<Readonly<Record<string, unknown>> | null> {
  return parseJsonObject(await readFile(prefsFile, 'utf-8'));
}

const ON: UpdatePreferences = { checkOnStartup: true };
const OFF: UpdatePreferences = { checkOnStartup: false };

describe('shouldCheckOnStartup', () => {
  it('uses the documented env var name', () => {
    expect(DISABLE_UPDATE_CHECK_ENV).toBe('COSTGOBLIN_DISABLE_UPDATE_CHECK');
  });

  it('checks a packaged build with the pref on and no env override', () => {
    expect(shouldCheckOnStartup({ isPackaged: true, prefs: ON, env: {} })).toBe(true);
  });

  it('never checks an unpackaged (dev / e2e) build', () => {
    expect(shouldCheckOnStartup({ isPackaged: false, prefs: ON, env: {} })).toBe(false);
  });

  it('does not check when the workspace preference is off', () => {
    expect(shouldCheckOnStartup({ isPackaged: true, prefs: OFF, env: {} })).toBe(false);
  });

  it('does not check when COSTGOBLIN_DISABLE_UPDATE_CHECK=1', () => {
    expect(shouldCheckOnStartup({
      isPackaged: true,
      prefs: ON,
      env: { COSTGOBLIN_DISABLE_UPDATE_CHECK: '1' },
    })).toBe(false);
  });

  it.each([
    ['"0"', '0'],
    ['"true"', 'true'],
    ['an empty string', ''],
    ['unset', undefined],
  ])('still checks when the env var is %s (only "1" disables)', (_label, value) => {
    expect(shouldCheckOnStartup({
      isPackaged: true,
      prefs: ON,
      env: { COSTGOBLIN_DISABLE_UPDATE_CHECK: value },
    })).toBe(true);
  });

  it('the env var cannot turn the check back on when the pref is off', () => {
    expect(shouldCheckOnStartup({
      isPackaged: true,
      prefs: OFF,
      env: { COSTGOBLIN_DISABLE_UPDATE_CHECK: '0' },
    })).toBe(false);
  });
});

describe('readCheckOnStartup', () => {
  it('is on when there is no prefs file', async () => {
    expect(await readCheckOnStartup(prefsFile)).toBe(true);
  });

  it('is on for a corrupt prefs file', async () => {
    await writeFile(prefsFile, '{ not json');
    expect(await readCheckOnStartup(prefsFile)).toBe(true);
  });

  it('is on without an updates slice', async () => {
    await writeFile(prefsFile, JSON.stringify({ telemetry: { errorReports: true } }));
    expect(await readCheckOnStartup(prefsFile)).toBe(true);
  });

  it('is on for a non-boolean flag', async () => {
    await writeFile(prefsFile, JSON.stringify({ updates: { checkOnStartup: 'no' } }));
    expect(await readCheckOnStartup(prefsFile)).toBe(true);
  });

  it('follows persistCheckOnStartup', async () => {
    await persistCheckOnStartup(prefsFile, false);
    expect(await readCheckOnStartup(prefsFile)).toBe(false);
    await persistCheckOnStartup(prefsFile, true);
    expect(await readCheckOnStartup(prefsFile)).toBe(true);
  });
});

describe('persistCheckOnStartup', () => {
  it('writes only the updates slice and keeps the others', async () => {
    await writeFile(prefsFile, JSON.stringify({ defaultViewId: 'overview', mcp: { enabled: true } }));
    await persistCheckOnStartup(prefsFile, false);
    expect(await readPrefs()).toStrictEqual({
      defaultViewId: 'overview',
      mcp: { enabled: true },
      updates: { checkOnStartup: false },
    });
  });

  it('keeps a concurrent telemetry write, and the telemetry writer keeps the updates slice', async () => {
    await writeFile(prefsFile, JSON.stringify({ performance: { threads: 4 } }));
    await Promise.all([
      persistCheckOnStartup(prefsFile, false),
      updatePrefsFile(prefsFile, (current) => ({ ...current, telemetry: { errorReports: true } })),
    ]);
    expect(await readPrefs()).toStrictEqual({
      performance: { threads: 4 },
      updates: { checkOnStartup: false },
      telemetry: { errorReports: true },
    });
  });

  it.each([
    ['the string "false"', 'false'],
    ['0', 0],
    ['null', null],
    ['undefined', undefined],
    ['an object', {}],
  ])('rejects %s without touching the file', async (_label, value) => {
    const original = JSON.stringify({ defaultViewId: 'overview', updates: { checkOnStartup: true } });
    await writeFile(prefsFile, original);
    await expect(persistCheckOnStartup(prefsFile, value)).rejects.toBeInstanceOf(TypeError);
    expect(await readFile(prefsFile, 'utf-8')).toBe(original);
  });

  it('rejects a non-boolean without creating a missing file', async () => {
    await expect(persistCheckOnStartup(prefsFile, 'false')).rejects.toBeInstanceOf(TypeError);
    await expect(readFile(prefsFile, 'utf-8')).rejects.toThrow();
  });
});
