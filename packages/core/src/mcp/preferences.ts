import { isStringRecord } from '../utils/json.js';

/**
 * Opt-in for the embedded MCP server. OFF by default, including for existing
 * installs: nothing listens on the MCP port until the user enables it under
 * Settings → AI Assistant. Stored under the `mcp` key of the active
 * workspace's ui-preferences.json, like the telemetry opt-in, because the MCP
 * server serves only the active workspace.
 */
export interface McpPreferences {
  readonly enabled: boolean;
}

export const MCP_PREFERENCES_DEFAULTS: McpPreferences = { enabled: false };

/**
 * Parse an untrusted blob (the `mcp` slice read back from ui-preferences.json)
 * into McpPreferences. Only a literal `true` enables the server; anything else
 * (missing, corrupt or hand-edited) fails closed to OFF.
 */
export function parseMcpPreferences(raw: unknown): McpPreferences {
  if (!isStringRecord(raw)) return MCP_PREFERENCES_DEFAULTS;
  return { enabled: raw['enabled'] === true };
}
