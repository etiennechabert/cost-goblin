import { ipcMain } from 'electron';
import { startMcpServer, stopMcpServer, isMcpServerRunning, getMcpToken, regenerateMcpToken } from '../mcp.js';
import { applyMcpEnabled, persistMcpEnabled } from '../mcp-prefs.js';
import { type AppContext, prefsPath } from './context.js';

export function registerMcpHandlers(app: AppContext): void {
  ipcMain.handle('mcp:get-running', (): boolean => {
    return isMcpServerRunning();
  });

  // Enable/Disable from Settings → AI Assistant. The choice is saved in the
  // workspace's ui-preferences.json and read once at launch (main.ts); see
  // applyMcpEnabled for the ordering and the payload check.
  ipcMain.handle('mcp:set-running', async (_event, value: unknown): Promise<void> => {
    const file = await prefsPath(app.ctx.stateDir, 'ui-preferences');
    await applyMcpEnabled(value, {
      persist: (enabled) => persistMcpEnabled(file, enabled),
      start: () => startMcpServer(app),
      stop: stopMcpServer,
      isRunning: isMcpServerRunning,
    });
  });

  ipcMain.handle('mcp:get-token', (): Promise<string> => {
    return getMcpToken();
  });

  ipcMain.handle('mcp:regenerate-token', (): Promise<string> => {
    return regenerateMcpToken();
  });
}
