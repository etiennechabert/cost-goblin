import { ipcMain } from 'electron';
import type { AppContext } from './context.js';

export function registerDebugHandlers(app: AppContext): void {
  ipcMain.handle('debug:get-query-log', () => {
    return app.queryLog.getEntries();
  });

  ipcMain.handle('debug:run-explain', async (_event, queryId: number): Promise<string> => {
    const entry = app.queryLog.getEntryForExplain(queryId);
    if (entry === undefined) return 'Query not found in log';
    const sql = `EXPLAIN ANALYZE ${entry.sql}`;
    try {
      const rows = await app.runPreparedQuery(sql, entry.params);
      return rows.map(r => Object.values(r).join('\t')).join('\n');
    } catch (err: unknown) {
      return `EXPLAIN failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  });

  ipcMain.handle('debug:clear-completed', () => {
    app.queryLog.clearCompleted();
  });

  ipcMain.handle('debug:clear-query-log', () => {
    app.queryLog.clear();
  });
}
