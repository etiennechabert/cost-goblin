import { ipcMain } from 'electron';
import { startMcpServer, stopMcpServer, isMcpServerRunning, getMcpToken, regenerateMcpToken } from '../mcp.js';
import type { AppContext } from './context.js';

export function registerMcpHandlers(app: AppContext): void {
  ipcMain.handle('mcp:get-running', (): boolean => {
    return isMcpServerRunning();
  });

  ipcMain.handle('mcp:set-running', async (_event, enabled: boolean): Promise<void> => {
    if (enabled && !isMcpServerRunning()) {
      await startMcpServer(app);
    } else if (!enabled && isMcpServerRunning()) {
      await stopMcpServer();
    }
  });

  ipcMain.handle('mcp:get-token', (): string => {
    return getMcpToken();
  });

  ipcMain.handle('mcp:regenerate-token', (): Promise<string> => {
    return regenerateMcpToken();
  });
}
