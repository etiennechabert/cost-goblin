import { ipcMain } from 'electron';
import { parseJsonObject, parseTelemetryPreferences } from '@costgoblin/core';
import type { TelemetryPreferences, TelemetryStatus, TelemetryOutboxEntry } from '@costgoblin/core';
import { type AppContext, prefsPath } from './context.js';
import { telemetry } from '../telemetry/controller.js';

/**
 * IPC surface for opt-in telemetry. Preferences live under the `telemetry` key
 * of ui-preferences.json (merged like the `performance` block so unrelated
 * settings are never clobbered). Writing them reconciles the running Sentry SDK
 * live via the controller.
 */
export function registerTelemetryHandlers(app: AppContext): void {
  const { ctx } = app;
  const uiPrefsPath = (): Promise<string> => prefsPath(ctx.dataDir, 'ui-preferences');

  async function readPrefs(): Promise<Readonly<Record<string, unknown>> | null> {
    const fs = await import('node:fs/promises');
    try {
      return parseJsonObject(await fs.readFile(await uiPrefsPath(), 'utf-8'));
    } catch {
      return null;
    }
  }

  ipcMain.handle('telemetry:get-preferences', async (): Promise<TelemetryPreferences> => {
    const parsed = await readPrefs();
    return parseTelemetryPreferences(parsed?.['telemetry']);
  });

  ipcMain.handle('telemetry:set-preferences', async (_event, prefs: TelemetryPreferences): Promise<void> => {
    // Re-parse the incoming value defensively — never trust the renderer payload
    // shape, and fail closed on anything unexpected.
    const normalized = parseTelemetryPreferences(prefs);
    const fs = await import('node:fs/promises');
    const existing = (await readPrefs()) ?? {};
    const merged = { ...existing, telemetry: normalized };
    await fs.writeFile(await uiPrefsPath(), JSON.stringify(merged, null, 2));
    await telemetry.applyPreferences(normalized);
  });

  ipcMain.handle('telemetry:get-status', (): TelemetryStatus => telemetry.getStatus());

  ipcMain.handle('telemetry:get-outbox', (): Promise<readonly TelemetryOutboxEntry[]> => telemetry.getOutbox());
}
