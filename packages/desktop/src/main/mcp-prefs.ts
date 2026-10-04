import { readFileSync } from 'node:fs';
import { logger, parseJsonObject, parseMcpPreferences } from '@costgoblin/core';
import { updatePrefsFile } from './handlers/prefs-file.js';

// The MCP opt-in lives in the `mcp` slice of the workspace's ui-preferences.json.
// No electron import, so main.ts, the IPC handler and the tests share it.

/** Whether the user enabled the MCP server. Fails closed: a missing, corrupt or
 *  hand-edited prefs file reads as OFF. Synchronous for the launch-time check. */
export function readMcpEnabledSync(file: string): boolean {
  try {
    return parseMcpPreferences(parseJsonObject(readFileSync(file, 'utf-8'))?.['mcp']).enabled;
  } catch {
    return false;
  }
}

/** Save the opt-in. Goes through updatePrefsFile, which serializes against the
 *  file's other writers (ui:save-preferences, perf:set, telemetry) so no slice
 *  is lost to a concurrent read-modify-write. */
export function persistMcpEnabled(file: string, enabled: boolean): Promise<void> {
  return updatePrefsFile(file, (current) => ({ ...current, mcp: { enabled } }));
}

/** Side effects {@link applyMcpEnabled} orchestrates, injected for tests. */
export interface ApplyMcpEnabledDeps {
  readonly persist: (enabled: boolean) => Promise<void>;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly isRunning: () => boolean;
}

/**
 * Apply the renderer's Enable/Disable choice (the `mcp:set-running` payload).
 *
 * The saved setting must never say "on" while the server is stopped, so:
 * - disable saves OFF first, then stops the server;
 * - enable starts the server first and saves ON only once it listens. A failed
 *   start saves OFF (best effort) and rethrows; a failed save stops the server
 *   if this call started it, and rethrows.
 *
 * The payload comes from the renderer, so anything but a boolean throws before
 * any side effect.
 */
export async function applyMcpEnabled(value: unknown, deps: ApplyMcpEnabledDeps): Promise<void> {
  if (typeof value !== 'boolean') {
    throw new TypeError('mcp:set-running expects a boolean');
  }

  if (!value) {
    await deps.persist(false);
    // Unconditional: isRunning() is false while a start or a token-rotation
    // restart is still in flight, and a Disable gated on it would be dropped
    // while that start goes on to listen. stop() is serialized behind any
    // in-flight start and is a no-op when nothing runs.
    await deps.stop();
    return;
  }

  const startedHere = !deps.isRunning();
  if (startedHere) {
    try {
      await deps.start();
    } catch (err: unknown) {
      await deps.persist(false).catch((persistErr: unknown) => {
        logger.warn(`mcp: could not save the setting as off after a failed start — ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`);
      });
      throw err;
    }
  }

  try {
    await deps.persist(true);
  } catch (err: unknown) {
    // Undo only what this call did: a server that was already running (e.g.
    // started at launch from the saved setting) is left as it was.
    if (startedHere) {
      await deps.stop().catch((stopErr: unknown) => {
        logger.warn(`mcp: could not stop the server after failing to save the setting — ${stopErr instanceof Error ? stopErr.message : String(stopErr)}`);
      });
    }
    throw err;
  }
}
