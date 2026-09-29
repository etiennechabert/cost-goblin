import { isStringRecord } from '../utils/json.js';

/**
 * Whether a release build checks GitHub Releases for a new version at launch.
 * ON by default, including for existing installs, so fleets don't stall on an
 * old Electron. Stored under the `updates` key of the active workspace's
 * ui-preferences.json, like the telemetry and MCP opt-ins; a managed install
 * can also force it off with `COSTGOBLIN_DISABLE_UPDATE_CHECK=1`. Only the
 * launch-time check is gated: a manual "Check for updates" always runs, and
 * nothing is ever downloaded or installed without a click.
 */
export interface UpdatePreferences {
  readonly checkOnStartup: boolean;
}

export const UPDATE_PREFERENCES_DEFAULTS: UpdatePreferences = { checkOnStartup: true };

/**
 * Parse an untrusted blob (the `updates` slice read back from
 * ui-preferences.json) into UpdatePreferences. Only a literal `false` turns the
 * startup check off; anything else (missing, corrupt or hand-edited) keeps the
 * default ON, so a damaged prefs file can't silently stop update notifications.
 */
export function parseUpdatePreferences(raw: unknown): UpdatePreferences {
  if (isStringRecord(raw) && raw['checkOnStartup'] === false) return { checkOnStartup: false };
  return UPDATE_PREFERENCES_DEFAULTS;
}
