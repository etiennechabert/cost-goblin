import { readFile } from 'node:fs/promises';
import { parseJsonObject, parseUpdatePreferences } from '@costgoblin/core';
import type { UpdatePreferences } from '@costgoblin/core';
import { updatePrefsFile } from './handlers/prefs-file.js';

// The startup update-check preference lives in the `updates` slice of the
// workspace's ui-preferences.json. No electron import, so main.ts, the IPC
// handler and the tests share it.

/** Managed-install kill switch: `COSTGOBLIN_DISABLE_UPDATE_CHECK=1` suppresses
 *  the launch-time check whatever the workspace preference says. Off-only — it
 *  can never turn a check on. */
export const DISABLE_UPDATE_CHECK_ENV = 'COSTGOBLIN_DISABLE_UPDATE_CHECK';

export interface StartupCheckInputs {
  readonly isPackaged: boolean;
  readonly prefs: UpdatePreferences;
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Whether to call GitHub Releases at launch. Gates ONLY the startup call: a
 *  manual "Check for updates" (and the error modal's Retry) always runs. Dev and
 *  e2e runs never check (no update feed for an unpackaged app). */
export function shouldCheckOnStartup({ isPackaged, prefs, env }: StartupCheckInputs): boolean {
  if (!isPackaged) return false;
  if (!prefs.checkOnStartup) return false;
  return env[DISABLE_UPDATE_CHECK_ENV] !== '1';
}

/** The saved preference for the settings UI. Fails open to the default (ON):
 *  a missing, corrupt or hand-edited prefs file reads as "check at startup". */
export async function readCheckOnStartup(file: string): Promise<boolean> {
  try {
    return parseUpdatePreferences(parseJsonObject(await readFile(file, 'utf-8'))?.['updates']).checkOnStartup;
  } catch {
    return true;
  }
}

/** Save the preference. The value arrives from the renderer over IPC, so
 *  anything but a boolean is rejected before any I/O. Goes through
 *  updatePrefsFile, which serializes against the file's other writers
 *  (ui:save-preferences, perf:set, telemetry, mcp) so no slice is lost to a
 *  concurrent read-modify-write. */
export async function persistCheckOnStartup(file: string, value: unknown): Promise<void> {
  if (typeof value !== 'boolean') {
    throw new TypeError('update:set-check-on-startup expects a boolean');
  }
  await updatePrefsFile(file, (current) => ({ ...current, updates: { checkOnStartup: value } }));
}
