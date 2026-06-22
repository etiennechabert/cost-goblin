import { ipcMain } from 'electron';
import type { AppContext } from './context.js';
import { registerCostHandlers } from './query-costs.js';
import { registerTrendHandlers } from './query-trends.js';
import { registerRecommendationHandlers } from './query-recommendations.js';
import { registerFilterHandlers } from './query-filters.js';

export function registerQueryHandlers(app: AppContext): void {
  ipcMain.handle('query:cancel-pending', () => {
    app.ctx.db.cancelPendingQueries();
  });
  ipcMain.handle('costs:await-base', (_event, timeoutMs: unknown): Promise<boolean> => {
    const ms = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 90_000;
    return app.awaitWarmup(ms);
  });
  ipcMain.handle('cache:clear-all', async () => {
    await app.clearAllCaches();
  });
  registerCostHandlers(app);
  registerTrendHandlers(app);
  registerRecommendationHandlers(app);
  registerFilterHandlers(app);
}
