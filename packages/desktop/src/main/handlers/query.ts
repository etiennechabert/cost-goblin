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
  registerCostHandlers(app);
  registerTrendHandlers(app);
  registerRecommendationHandlers(app);
  registerFilterHandlers(app);
}
